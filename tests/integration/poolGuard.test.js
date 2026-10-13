const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const { createUser, createEvent, lockSeat, bookSeat, uniq, closeDb } = require('../support/helpers');

afterAll(closeDb);

test('a booking request gets an immediate 503 with Retry-After while others are queued for a connection', async () => {
  const user = await createUser();
  const { seats } = await createEvent(1);
  await lockSeat(user.accessToken, seats[0].id);

  const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(pool), 'waitingCount');
  Object.defineProperty(pool, 'waitingCount', { get: () => 3, configurable: true });
  try {
    const started = Date.now();
    const res = await bookSeat(user.accessToken, seats[0].id, `key-${uniq()}`);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    delete pool.waitingCount;
    if (original) Object.defineProperty(Object.getPrototypeOf(pool), 'waitingCount', original);
  }

  // once the queue is gone, the same request works normally
  const ok = await bookSeat(user.accessToken, seats[0].id, `key-${uniq()}`);
  expect(ok.status).toBe(201);
});
