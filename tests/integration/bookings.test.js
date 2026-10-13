const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const paymentService = require('../../src/services/paymentService');
const {
  createUser, createEvent, lockSeat, bookSeat, bearer, uniq, closeDb,
} = require('../support/helpers');

afterAll(closeDb);

const charges = () => paymentService.getStats().charges;

async function lockedSeat(user) {
  const { seats } = await createEvent(1);
  await lockSeat(user.accessToken, seats[0].id);
  return seats[0].id;
}

async function bookingRows(seatId) {
  const { rows } = await pool.query('SELECT status FROM bookings WHERE seat_id = $1', [seatId]);
  return rows.map((r) => r.status);
}

describe('creating a booking', () => {
  test('confirms a locked seat', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);

    const res = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);
    expect(res.status).toBe(201);
    expect(res.body.booking.status).toBe('CONFIRMED');
    expect(res.body.booking.user_id).toBe(user.id);

    const seat = await pool.query('SELECT status FROM seats WHERE id = $1', [seatId]);
    expect(seat.rows[0].status).toBe('BOOKED');
  });

  test('validates its input', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);

    expect((await request(app).post('/api/bookings').send({ seatId })).status).toBe(401);
    expect((await bookSeat(user.accessToken, seatId, 'short')).status).toBe(400);
    expect((await bookSeat(user.accessToken, 'not-a-uuid', `key-${uniq()}`)).status).toBe(400);
    expect((await bookSeat(user.accessToken, seatId, `key-${uniq()}`, { simulate: 'bogus' })).status).toBe(400);
    expect((await bookSeat(user.accessToken, crypto.randomUUID(), `key-${uniq()}`)).status).toBe(404);
  });

  test('requires a lock held by the caller, and a body userId is ignored', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const seatId = await lockedSeat(alice);

    const asBob = await bookSeat(bob.accessToken, seatId, `key-${uniq()}`);
    expect(asBob.status).toBe(409);

    const spoof = await bookSeat(bob.accessToken, seatId, `key-${uniq()}`, { userId: alice.id });
    expect(spoof.status).toBe(409);

    const { seats } = await createEvent(1);
    const neverLocked = await bookSeat(alice.accessToken, seats[0].id, `key-${uniq()}`);
    expect(neverLocked.status).toBe(409);
  });

  test('a booking is visible to its owner only', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const seatId = await lockedSeat(alice);
    const created = await bookSeat(alice.accessToken, seatId, `key-${uniq()}`);
    const url = `/api/bookings/${created.body.booking.id}`;

    expect((await request(app).get(url).set(bearer(alice.accessToken))).status).toBe(200);
    expect((await request(app).get(url).set(bearer(bob.accessToken))).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(401);
  });
});

describe('idempotency', () => {
  test('replaying a key returns the same booking and does not charge again', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const key = `key-${uniq()}`;

    const first = await bookSeat(user.accessToken, seatId, key);
    const before = charges();
    const replay = await bookSeat(user.accessToken, seatId, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.booking.id).toBe(first.body.booking.id);
    expect(charges()).toBe(before);
  });

  test('reusing a key for a different seat is rejected with 422', async () => {
    const user = await createUser();
    const seatA = await lockedSeat(user);
    const seatB = await lockedSeat(user);
    const key = `key-${uniq()}`;

    await bookSeat(user.accessToken, seatA, key);
    expect((await bookSeat(user.accessToken, seatB, key)).status).toBe(422);
  });

  test('reusing a key as a different user is rejected with 422', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const seatId = await lockedSeat(alice);
    const key = `key-${uniq()}`;

    await bookSeat(alice.accessToken, seatId, key);
    expect((await bookSeat(bob.accessToken, seatId, key)).status).toBe(422);
  });

  test('50 parallel requests with the same key: one booking, one charge', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const key = `key-${uniq()}`;
    const before = charges();

    const results = await Promise.all(
      Array.from({ length: 50 }, () => bookSeat(user.accessToken, seatId, key))
    );
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.every((c) => [200, 201, 202].includes(c))).toBe(true);
    expect(charges() - before).toBe(1);
    expect(await bookingRows(seatId)).toEqual(['CONFIRMED']);
  });

  test('50 parallel double-clicks with different keys: one booking, one charge', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const before = charges();

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bookSeat(user.accessToken, seatId, `key-${uniq()}-${i}`))
    );
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);
    expect(charges() - before).toBe(1);
    expect(await bookingRows(seatId)).toEqual(['CONFIRMED']);
  });
});

describe('payment failure', () => {
  test('a declined payment keeps the lock, and a retry with a new key succeeds', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const failKey = `key-${uniq()}`;

    const declined = await bookSeat(user.accessToken, seatId, failKey, { simulate: 'fail' });
    expect(declined.status).toBe(402);
    expect(declined.body.reason).toBe('CARD_DECLINED');

    const replayed = await bookSeat(user.accessToken, seatId, failKey);
    expect(replayed.status).toBe(402);
    expect(replayed.body.booking.id).toBe(declined.body.booking.id);

    const retry = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);
    expect(retry.status).toBe(201);
    expect((await bookingRows(seatId)).sort()).toEqual(['CONFIRMED', 'FAILED']);
  });
});

describe('database safety nets', () => {
  test('a second CONFIRMED booking for one seat is rejected by the partial unique index', async () => {
    const user = await createUser();
    const other = await createUser();
    const seatId = await lockedSeat(user);
    await bookSeat(user.accessToken, seatId, `key-${uniq()}`);

    await expect(
      pool.query(
        "INSERT INTO bookings (seat_id, user_id, status, idempotency_key) VALUES ($1, $2, 'CONFIRMED', $3)",
        [seatId, other.id, `raw-${uniq()}`]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_one_confirmed_booking_per_seat' });
  });

  test('foreign keys reject a lock or booking for a user that does not exist', async () => {
    const { seats } = await createEvent(1);
    const ghost = crypto.randomUUID();

    await expect(
      pool.query('UPDATE seats SET locked_by = $1 WHERE id = $2', [ghost, seats[0].id])
    ).rejects.toMatchObject({ code: '23503' });

    await expect(
      pool.query(
        "INSERT INTO bookings (seat_id, user_id, status, idempotency_key) VALUES ($1, $2, 'PENDING', $3)",
        [seats[0].id, ghost, `raw-${uniq()}`]
      )
    ).rejects.toMatchObject({ code: '23503' });
  });
});
