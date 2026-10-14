// Regression test for connection-pool starvation in reserveForPayment.
//
// A request used to hold a pooled client while calling pool.query for the idempotency lookup, so it
// needed two connections at once. With more requests in flight than pool connections they all
// waited on each other until the 5 second connection timeout fired and returned 500.
//
// The pool-saturation guard (503 while requests are queued for a connection) would shed these requests
// before they reach the code under test, so it is switched off for this file. The pool size is fixed when
// the process starts, so this file only runs with a tiny pool:
//   npm run test:pool
process.env.POOL_GUARD_MAX_WAITING = '1000000';

const { createUser, createEvent, lockSeat, bookSeat, uniq, closeDb } = require('../support/helpers');
const pool = require('../../src/config/db');

afterAll(closeDb);

const runWithTinyPool = pool.options.max <= 3 ? test : test.skip;

runWithTinyPool('20 parallel same-key bookings succeed with a pool of only 2 connections', async () => {
  const user = await createUser();
  const { seats } = await createEvent(1);
  await lockSeat(user.accessToken, seats[0].id);
  const key = `key-${uniq()}`;

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 20 }, () => bookSeat(user.accessToken, seats[0].id, key))
  );
  const codes = results.map((r) => r.status);

  expect(codes.filter((c) => c >= 500)).toHaveLength(0);
  expect(codes.filter((c) => c === 201)).toHaveLength(1);
  expect(Date.now() - started).toBeLessThan(4000); // the old failure took 5s+ (connection timeout)
});
