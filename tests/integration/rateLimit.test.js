// These tests need a running Redis (docker-compose up -d). The limiter is switched off for the rest of
// the suite (NODE_ENV=test) and force-enabled here.
process.env.RATE_LIMIT_FORCE = 'true';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const request = require('supertest');
const app = require('../../src/app');
const { getApiRedis, closeApiRedis } = require('../../src/config/redis');
const { createUser, uniq, PASSWORD, bearer, createEvent, lockSeat, closeDb } = require('../support/helpers');

afterAll(async () => {
  await closeApiRedis();
  await closeDb();
});

// Each test uses a fresh email/user, so counters never collide between tests.
const login = (email, password = 'wrong-password-1') =>
  request(app).post('/api/auth/login').send({ email, password });

describe('login limit', () => {
  test('the 6th attempt for one email is rejected with 429 and Retry-After', async () => {
    const email = `rl-${uniq()}@test.example.com`;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await login(email)).status);

    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);

    const blocked = await login(email);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['ratelimit-remaining']).toBe('0');
  });

  test('a rate limited email does not block a different email from the same IP', async () => {
    const blockedEmail = `rl-${uniq()}@test.example.com`;
    for (let i = 0; i < 6; i++) await login(blockedEmail);
    expect((await login(blockedEmail)).status).toBe(429);

    const other = await createUser();
    const res = await login(other.email, PASSWORD);
    expect(res.status).toBe(200);
  });

  test('10 parallel attempts with limit 5: exactly 5 pass and 5 are rejected', async () => {
    const email = `rl-${uniq()}@test.example.com`;
    const results = await Promise.all(Array.from({ length: 10 }, () => login(email)));
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 401)).toHaveLength(5);
    expect(codes.filter((c) => c === 429)).toHaveLength(5);
  });

  test('the window is a real expiry: the counter key has a TTL', async () => {
    const email = `rl-${uniq()}@test.example.com`;
    await login(email);
    const keys = await getApiRedis().keys(`rl:login:*:${email}`);
    expect(keys).toHaveLength(1);
    const ttl = await getApiRedis().pttl(keys[0]);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
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

    // another user is unaffected
    expect((await lockSeat(light.accessToken, seats[0].id)).status).not.toBe(429);
  });
});

describe('Redis outage', () => {
  test('fails open: requests are still served when Redis is unreachable', async () => {
    const redis = getApiRedis();
    const originalEval = redis.eval.bind(redis);
    redis.eval = () => Promise.reject(new Error('Connection is closed'));
    try {
      const user = await createUser();
      const res = await request(app).get('/api/auth/me').set(bearer(user.accessToken));
      expect(res.status).toBe(200);

      const attempts = [];
      for (let i = 0; i < 8; i++) attempts.push((await login(`out-${uniq()}@test.example.com`)).status);
      expect(attempts.every((c) => c === 401)).toBe(true); // never 429, never 500
    } finally {
      redis.eval = originalEval;
    }
  });
});
