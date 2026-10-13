// Needs a running Redis (docker-compose up -d). The limiter is off for the rest of the suite
// (NODE_ENV=test) and force-enabled here.
process.env.RATE_LIMIT_FORCE = 'true';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
// A fresh key namespace per run, so counters from earlier runs can never leak into this one.
process.env.RATE_LIMIT_PREFIX = `rltest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
// Trust one proxy hop so each test can present its own client IP through X-Forwarded-For.
process.env.TRUST_PROXY = '1';

const request = require('supertest');
const app = require('../../src/app');
const { getApiRedis, closeApiRedis } = require('../../src/config/redis');
const { createUser, uniq, PASSWORD, bearer, createEvent, lockSeat, closeDb } = require('../support/helpers');

const PREFIX = process.env.RATE_LIMIT_PREFIX;

afterAll(async () => {
  const redis = getApiRedis();
  const keys = await redis.keys(`${PREFIX}:*`);
  if (keys.length > 0) await redis.del(...keys);
  await closeApiRedis();
  await closeDb();
});

const octet = () => Math.floor(Math.random() * 250);
const fakeIp = () => `10.${octet()}.${octet()}.${octet()}`;
const newEmail = () => `rl-${uniq()}@test.example.com`;

const login = (email, ip, password = 'wrong-password-1') =>
  request(app).post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('login limit', () => {
  test('the 6th attempt for one email from one IP is rejected with 429 and Retry-After', async () => {
    const email = newEmail();
    const ip = fakeIp();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(email, ip)).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);

    const blocked = await login(email, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
  });

  test('a blocked email does not block another email from the same IP', async () => {
    const ip = fakeIp();
    const blockedEmail = newEmail();
    for (let i = 0; i < 6; i++) await login(blockedEmail, ip);
    expect((await login(blockedEmail, ip)).status).toBe(429);

    const other = await createUser();
    expect((await login(other.email, ip, PASSWORD)).status).toBe(200);
  });

  test('the limit is per IP: the same email from another IP is not blocked', async () => {
    const email = newEmail();
    const attacker = fakeIp();
    for (let i = 0; i < 6; i++) await login(email, attacker);
    expect((await login(email, attacker)).status).toBe(429);
    expect((await login(email, fakeIp())).status).toBe(401);
  });

  test('10 parallel attempts with limit 5: exactly 5 pass and 5 are rejected', async () => {
    const email = newEmail();
    const ip = fakeIp();
    const results = await Promise.all(Array.from({ length: 10 }, () => login(email, ip)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  test('the window is a real expiry: the counter key has a TTL', async () => {
    const email = newEmail();
    const ip = fakeIp();
    await login(email, ip);
    const ttl = await getApiRedis().pttl(`${PREFIX}:login:${ip}:${email}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
  });
});

describe('register limit', () => {
  test('the 11th signup from one IP in a window is rejected', async () => {
    const ip = fakeIp();
    const codes = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(app)
        .post('/api/auth/register')
        .set('X-Forwarded-For', ip)
        .send({ email: newEmail(), name: 'R', password: PASSWORD });
      codes.push(res.status);
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

describe('lock limit', () => {
  test('is applied per user: 30 per minute, the 31st is rejected', async () => {
    const heavy = await createUser();
    const light = await createUser();
    const { seats } = await createEvent(1);

    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await lockSeat(heavy.accessToken, seats[0].id)).status);
    expect(codes.slice(0, 30).every((c) => c !== 429)).toBe(true);
    expect(codes[30]).toBe(429);

    expect((await lockSeat(light.accessToken, seats[0].id)).status).not.toBe(429);
  });
});

describe('Redis outage', () => {
  test('fails open: requests are still served when the limiter cannot reach Redis', async () => {
    const redis = getApiRedis();
    const originalEval = redis.eval.bind(redis);
    redis.eval = () => Promise.reject(new Error('Connection is closed'));
    try {
      const ip = fakeIp();
      const codes = [];
      for (let i = 0; i < 8; i++) codes.push((await login(newEmail(), ip)).status);
      expect(codes.every((c) => c === 401)).toBe(true); // never 429, never 500
    } finally {
      redis.eval = originalEval;
    }
  });
});
