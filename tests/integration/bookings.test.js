const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const { setPaymentGateway } = require('../../src/services/payment');
const { createFakeGateway } = require('../support/fakeGateway');
const {
  createUser, createEvent, lockSeat, bookSeat, bookSeatRetry, bearer, uniq, closeDb,
} = require('../support/helpers');

let gateway;
beforeEach(() => {
  gateway = createFakeGateway();
  setPaymentGateway(gateway);
});
afterAll(async () => {
  setPaymentGateway(null);
  await closeDb();
});

async function lockedSeat(user, pricePaise) {
  const { seats } = await createEvent(1, pricePaise);
  await lockSeat(user.accessToken, seats[0].id);
  return seats[0].id;
}

async function pendingBooking(pricePaise) {
  const user = await createUser();
  const seatId = await lockedSeat(user, pricePaise);
  const res = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);
  return { user, seatId, booking: res.body.booking, orderId: res.body.payment.orderId };
}

const bookingRow = async (id) => (await pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
const bookingStatuses = async (seatId) =>
  (await pool.query('SELECT status FROM bookings WHERE seat_id = $1', [seatId])).rows.map((r) => r.status);
const seatRow = async (id) => (await pool.query('SELECT * FROM seats WHERE id = $1', [id])).rows[0];
const verify = (token, bookingId, body) =>
  request(app).post(`/api/bookings/${bookingId}/verify`).set(bearer(token)).send(body);
const checkoutBody = (orderId, paymentId, signature) => ({
  razorpay_order_id: orderId,
  razorpay_payment_id: paymentId,
  razorpay_signature: signature ?? gateway.checkoutSignature(orderId, paymentId),
});

describe('creating a booking', () => {
  test('creates a PENDING booking and a gateway order for the event price', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user, 25000);

    const res = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);
    expect(res.status).toBe(201);
    expect(res.body.booking).toMatchObject({ status: 'PENDING', user_id: user.id, amount_paise: 25000, currency: 'INR' });
    expect(res.body.payment).toMatchObject({
      amount: 25000,
      currency: 'INR',
      keyId: 'rzp_test_fakekey',
      orderId: res.body.booking.gateway_order_id,
    });

    expect(gateway.calls.createOrder).toBe(1);
    expect(gateway.orders.get(res.body.payment.orderId)).toMatchObject({ amount: 25000, receipt: res.body.booking.id });
  });

  test('keeps the seat locked through the payment window and its grace period', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const res = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);

    const booking = await bookingRow(res.body.booking.id);
    const seat = await seatRow(seatId);
    const minutesLeft = (new Date(booking.expires_at) - Date.now()) / 60000;
    expect(minutesLeft).toBeGreaterThan(9);
    expect(minutesLeft).toBeLessThanOrEqual(10);
    expect(new Date(seat.locked_until).getTime()).toBeGreaterThan(new Date(booking.expires_at).getTime());
  });

  test('validates its input', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);

    expect((await request(app).post('/api/bookings').send({ seatId })).status).toBe(401);
    expect((await bookSeat(user.accessToken, seatId, 'short')).status).toBe(400);
    expect((await bookSeat(user.accessToken, 'not-a-uuid', `key-${uniq()}`)).status).toBe(400);
    expect((await bookSeat(user.accessToken, crypto.randomUUID(), `key-${uniq()}`)).status).toBe(404);
    expect(gateway.calls.createOrder).toBe(0);
  });

  test('requires a lock held by the caller, and a body userId is ignored', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const seatId = await lockedSeat(alice);

    expect((await bookSeat(bob.accessToken, seatId, `key-${uniq()}`)).status).toBe(409);
    expect((await bookSeat(bob.accessToken, seatId, `key-${uniq()}`, { userId: alice.id })).status).toBe(409);

    const { seats } = await createEvent(1);
    expect((await bookSeat(alice.accessToken, seats[0].id, `key-${uniq()}`)).status).toBe(409);
    expect(gateway.calls.createOrder).toBe(0);
  });

  test('a booking is visible to its owner only', async () => {
    const { user, booking } = await pendingBooking();
    const other = await createUser();
    const url = `/api/bookings/${booking.id}`;

    expect((await request(app).get(url).set(bearer(user.accessToken))).status).toBe(200);
    expect((await request(app).get(url).set(bearer(other.accessToken))).status).toBe(404);
    expect((await request(app).get(url)).status).toBe(401);
  });
});

describe('idempotency', () => {
  test('replaying a key returns the same order and creates no second one', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const key = `key-${uniq()}`;

    const first = await bookSeat(user.accessToken, seatId, key);
    const replay = await bookSeat(user.accessToken, seatId, key);

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.booking.id).toBe(first.body.booking.id);
    expect(replay.body.payment.orderId).toBe(first.body.payment.orderId);
    expect(gateway.calls.createOrder).toBe(1);
  });

  test('reusing a key for another seat or another user is rejected with 422', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const seatA = await lockedSeat(alice);
    const seatB = await lockedSeat(alice);
    const key = `key-${uniq()}`;

    await bookSeat(alice.accessToken, seatA, key);
    expect((await bookSeat(alice.accessToken, seatB, key)).status).toBe(422);
    expect((await bookSeat(bob.accessToken, seatA, key)).status).toBe(422);
  });

  test('50 parallel requests with the same key: one booking, one gateway order', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const key = `key-${uniq()}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => bookSeatRetry(user.accessToken, seatId, key))
    );
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.every((c) => [200, 201, 202].includes(c))).toBe(true);
    expect(gateway.calls.createOrder).toBe(1);
    expect(await bookingStatuses(seatId)).toEqual(['PENDING']);
  });

  test('50 parallel double-clicks with different keys: one booking, one gateway order', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);

    const results = await Promise.all(
      Array.from({ length: 50 }, (_, i) => bookSeatRetry(user.accessToken, seatId, `key-${uniq()}-${i}`))
    );
    const codes = results.map((r) => r.status);

    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);
    expect(gateway.calls.createOrder).toBe(1);
    expect(await bookingStatuses(seatId)).toEqual(['PENDING']);
  });
});

describe('gateway failure', () => {
  test('a failed order keeps the seat locked, replays as 502, and a new key succeeds', async () => {
    const user = await createUser();
    const seatId = await lockedSeat(user);
    const failedKey = `key-${uniq()}`;

    gateway.failNextCreateOrder();
    const failed = await bookSeat(user.accessToken, seatId, failedKey);
    expect(failed.status).toBe(502);
    expect(await bookingStatuses(seatId)).toEqual(['FAILED']);
    expect((await seatRow(seatId)).status).toBe('LOCKED');

    const replay = await bookSeat(user.accessToken, seatId, failedKey);
    expect(replay.status).toBe(502);
    expect(gateway.calls.createOrder).toBe(1);

    const retry = await bookSeat(user.accessToken, seatId, `key-${uniq()}`);
    expect(retry.status).toBe(201);
  });
});

describe('checkout verification', () => {
  test('confirms the booking once the order is paid and the signature is valid', async () => {
    const { user, seatId, booking, orderId } = await pendingBooking();
    const paymentId = gateway.payOrder(orderId);

    const res = await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId));
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ status: 'CONFIRMED', payment_id: paymentId });
    expect((await seatRow(seatId)).status).toBe('BOOKED');

    // Verifying again is harmless.
    expect((await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId))).status).toBe(200);
  });

  test('a valid signature is not enough: an unpaid order stays pending (202)', async () => {
    const { user, seatId, booking, orderId } = await pendingBooking();

    const res = await verify(user.accessToken, booking.id, checkoutBody(orderId, 'pay_not_really_paid'));
    expect(res.status).toBe(202);
    expect((await bookingRow(booking.id)).status).toBe('PENDING');
    expect((await seatRow(seatId)).status).toBe('LOCKED');
  });

  test('a partial payment does not confirm', async () => {
    const { user, booking, orderId } = await pendingBooking(10000);
    const paymentId = gateway.payOrder(orderId, { amount: 5000 });

    expect((await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId))).status).toBe(202);
    expect((await bookingRow(booking.id)).status).toBe('PENDING');
  });

  test('rejects a forged signature, a signature for another payment, and another order id', async () => {
    const { user, booking, orderId } = await pendingBooking();
    const paymentId = gateway.payOrder(orderId);

    expect((await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId, 'f'.repeat(64)))).status).toBe(400);
    const signatureForOther = gateway.checkoutSignature(orderId, 'pay_other');
    expect((await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId, signatureForOther))).status).toBe(400);
    expect((await verify(user.accessToken, booking.id, checkoutBody('order_someone_elses', paymentId))).status).toBe(400);
    expect((await bookingRow(booking.id)).status).toBe('PENDING');
  });

  test('only the owner can verify, and the body must be complete', async () => {
    const { user, booking, orderId } = await pendingBooking();
    const other = await createUser();
    const paymentId = gateway.payOrder(orderId);

    expect((await verify(other.accessToken, booking.id, checkoutBody(orderId, paymentId))).status).toBe(404);
    expect((await verify(user.accessToken, booking.id, {})).status).toBe(400);
    expect((await verify(user.accessToken, 'not-a-uuid', checkoutBody(orderId, paymentId))).status).toBe(400);
  });
});

describe('database safety nets', () => {
  test('a second CONFIRMED booking for one seat is rejected by the partial unique index', async () => {
    const { user, seatId, booking, orderId } = await pendingBooking();
    const other = await createUser();
    const paymentId = gateway.payOrder(orderId);
    await verify(user.accessToken, booking.id, checkoutBody(orderId, paymentId));

    await expect(
      pool.query(
        "INSERT INTO bookings (seat_id, user_id, status, idempotency_key) VALUES ($1, $2, 'CONFIRMED', $3)",
        [seatId, other.id, `raw-${uniq()}`]
      )
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_one_confirmed_booking_per_seat' });
  });

  test('one gateway payment cannot be attached to two bookings', async () => {
    const first = await pendingBooking();
    const second = await pendingBooking();
    await pool.query('UPDATE bookings SET payment_id = $1 WHERE id = $2', ['pay_shared', first.booking.id]);

    await expect(
      pool.query('UPDATE bookings SET payment_id = $1 WHERE id = $2', ['pay_shared', second.booking.id])
    ).rejects.toMatchObject({ code: '23505', constraint: 'idx_bookings_payment_id_unique' });
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
