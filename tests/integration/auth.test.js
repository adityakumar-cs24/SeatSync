const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const { createUser, bearer, uniq, PASSWORD, closeDb } = require('../support/helpers');

afterAll(closeDb);

const post = (url) => request(app).post(url);
const me = (token) => request(app).get('/api/auth/me').set(bearer(token));
const newEmail = () => `a-${uniq()}@test.example.com`;

describe('registration', () => {
  test('creates a normal user, ignores a role in the body and never returns the hash', async () => {
    const res = await post('/api/auth/register').send({
      email: newEmail(),
      name: 'R',
      password: PASSWORD,
      role: 'admin',
    });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('user');
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  test('emails are case-insensitive', async () => {
    const email = newEmail();
    const first = await post('/api/auth/register').send({ email, name: 'R', password: PASSWORD });
    const second = await post('/api/auth/register').send({
      email: email.toUpperCase(),
      name: 'R',
      password: PASSWORD,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test('10 concurrent signups with one email: exactly one wins', async () => {
    const email = newEmail();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/auth/register').send({ email, name: 'R', password: PASSWORD })
      )
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(9);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows[0].n).toBe(1);
  });

  test.each([
    ['a missing body', undefined],
    ['an invalid email', { email: 'nope', name: 'R', password: PASSWORD }],
    ['a short password', { email: 'x@test.example.com', name: 'R', password: 'short' }],
    ['a password over 72 bytes', { email: 'x@test.example.com', name: 'R', password: 'a'.repeat(73) }],
  ])('rejects %s with 400', async (_label, body) => {
    const req = post('/api/auth/register');
    const res = body === undefined ? await req : await req.send(body);
    expect(res.status).toBe(400);
  });
});

describe('login', () => {
  test('stores only a bcrypt hash', async () => {
    const user = await createUser();
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(rows[0].password_hash).not.toContain(PASSWORD);
  });

  test('wrong password and unknown email give the same response', async () => {
    const user = await createUser();
    const wrong = await post('/api/auth/login').send({ email: user.email, password: 'wrong-password-1' });
    const unknown = await post('/api/auth/login').send({ email: newEmail(), password: PASSWORD });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  test('rejects a request without credentials', async () => {
    const res = await post('/api/auth/login').send({});
    expect(res.status).toBe(400);
  });
});

describe('access tokens', () => {
  test('a valid token reaches /me', async () => {
    const user = await createUser();
    const res = await me(user.accessToken);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
  });

  test('no token gives 401', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  test('a tampered token gives TOKEN_INVALID', async () => {
    const user = await createUser();
    const res = await me(`${user.accessToken}x`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('an expired token gives TOKEN_EXPIRED', async () => {
    const user = await createUser();
    const expired = jwt.sign({}, process.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: user.id,
      expiresIn: -10,
    });
    const res = await me(expired);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  test('an unsigned alg:none token is rejected', async () => {
    const user = await createUser();
    const part = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const forged = `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: user.id })}.`;
    const res = await me(forged);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('TOKEN_INVALID');
  });

  test('a validly signed token for a user that does not exist gives 401', async () => {
    const ghost = jwt.sign({}, process.env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      subject: crypto.randomUUID(),
      expiresIn: '5m',
    });
    const res = await me(ghost);
    expect(res.status).toBe(401);
  });
});

describe('refresh tokens', () => {
  test('rotation: the new token works and a new refresh token is issued', async () => {
    const user = await createUser();
    const res = await post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(user.refreshToken);
    expect((await me(res.body.accessToken)).status).toBe(200);
  });

  test('reusing a rotated token revokes the whole session', async () => {
    const user = await createUser();
    const rotated = await post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(rotated.status).toBe(200);

    const reuse = await post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_INVALID');

    const afterTheft = await post('/api/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterTheft.status).toBe(401);
  });

  test('10 parallel refreshes with one token: exactly one succeeds', async () => {
    const user = await createUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post('/api/auth/refresh').send({ refreshToken: user.refreshToken })
      )
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 401)).toHaveLength(9);

    // The losers presented an already-used token, so the whole session was revoked.
    const { rows } = await pool.query(
      'SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active FROM refresh_tokens WHERE user_id = $1',
      [user.id]
    );
    expect(rows[0].active).toBe(0);
  });

  test('logout revokes the session and always returns 204', async () => {
    const user = await createUser();
    const out = await post('/api/auth/logout').send({ refreshToken: user.refreshToken });
    expect(out.status).toBe(204);

    const after = await post('/api/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(after.status).toBe(401);

    const unknown = await post('/api/auth/logout').send({ refreshToken: 'does-not-exist' });
    expect(unknown.status).toBe(204);
  });

  test('only the SHA-256 hash of a refresh token is stored', async () => {
    const user = await createUser();
    const hash = crypto.createHash('sha256').update(user.refreshToken).digest('hex');

    const stored = await pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1', [hash]);
    const plaintext = await pool.query('SELECT 1 FROM refresh_tokens WHERE token_hash = $1', [user.refreshToken]);
    expect(stored.rowCount).toBe(1);
    expect(plaintext.rowCount).toBe(0);
  });

  test('missing and garbage tokens are rejected', async () => {
    expect((await post('/api/auth/refresh').send({})).status).toBe(400);
    expect((await post('/api/auth/refresh').send({ refreshToken: 'garbage' })).status).toBe(401);
    expect((await post('/api/auth/logout').send({})).status).toBe(400);
  });
});
