const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const { setPaymentGateway } = require('../../src/services/payment');
const payments = require('../../src/services/paymentConfirmation');
const { createFakeGateway } = require('../support/fakeGateway');
const { createUser, createEvent, lockSeat, bookSeat, uniq, closeDb } = require('../support/helpers');

let gateway;
beforeEach(() => {
  gateway = createFakeGateway();
  setPaymentGateway(gateway);
});
afterEach(() => jest.restoreAllMocks());
afterAll(async () => {
  setPaymentGateway(null);
  await closeDb();
});

// Sends the delivery exactly as signed, unless a field is overridden. signature: null omits the header.
function deliver({ body, eventId, signature }, overrides = {}) {
  const req = request(app).post('/api/webhooks/razorpay').set('Content-Type', 'application/json');
  const sig = 'signature' in overrides ? overrides.signature : signature;
  if (sig !== null) req.set('X-Razorpay-Signature', sig);
  req.set('x-razorpay-event-id', overrides.eventId ?? eventId);
  return req.send(overrides.body ?? body);
}

async function pendingBooking(pricePaise) {
  const user = await createUser();
  const { seats } = await createEvent(1, pricePaise);
  await lockSeat(user.accessToken, seats[0].id);
  const res = await bookSeat(user.accessToken, seats[0].id, `key-${uniq()}`);
  return { user, seatId: seats[0].id, booking: res.body.booking, orderId: res.body.payment.orderId };
}

const bookingRow = async (id) => (await pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
const seatRow = async (id) => (await pool.query('SELECT * FROM seats WHERE id = $1', [id])).rows[0];
const eventCount = async (eventId) =>
  (await pool.query('SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1', [eventId])).rows[0].n;

describe('signature verification', () => {
  test('rejects a missing signature, a wrong one and a tampered body, and changes nothing', async () => {
    const { booking, orderId } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_x1' });

    expect((await deliver(w, { signature: null })).status).toBe(401);
    expect((await deliver(w, { signature: 'f'.repeat(64) })).status).toBe(401);
    expect((await deliver(w, { body: w.body.replace('pay_x1', 'pay_x2') })).status).toBe(401);

    expect((await bookingRow(booking.id)).status).toBe('PENDING');
    expect(await eventCount(w.eventId)).toBe(0);
  });

  test('rejects a body that was parsed and re-serialised, because the signature covers the raw bytes', async () => {
    const { orderId } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_x1' });
    const reserialised = JSON.stringify(JSON.parse(w.body), null, 2);

    expect((await deliver(w, { body: reserialised })).status).toBe(401);
  });
});

describe('payment events', () => {
  test('order.paid confirms the booking and books the seat', async () => {
    const { seatId, booking, orderId, user } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_ok_1' });

    const res = await deliver(w);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe('CONFIRMED');

    expect(await bookingRow(booking.id)).toMatchObject({ status: 'CONFIRMED', payment_id: 'pay_ok_1' });
    expect(await seatRow(seatId)).toMatchObject({ status: 'BOOKED', locked_by: user.id, locked_until: null });
  });

  test('payment.captured confirms too', async () => {
    const { booking, orderId } = await pendingBooking();
    const res = await deliver(gateway.webhook({ event: 'payment.captured', orderId, paymentId: 'pay_ok_2' }));

    expect(res.body.result).toBe('CONFIRMED');
    expect((await bookingRow(booking.id)).status).toBe('CONFIRMED');
  });

  test('an unknown order is acknowledged and ignored; other event types do nothing', async () => {
    const unknown = await deliver(gateway.webhook({ orderId: 'order_nobody_knows', paymentId: 'pay_z' }));
    expect(unknown.status).toBe(200);
    expect(unknown.body.result).toBe('UNKNOWN_ORDER');

    const { booking, orderId } = await pendingBooking();
    const failedEvent = await deliver(gateway.webhook({ event: 'payment.failed', orderId, paymentId: 'pay_f' }));
    expect(failedEvent.status).toBe(200);
    expect(failedEvent.body.result).toBe('IGNORED');
    expect((await bookingRow(booking.id)).status).toBe('PENDING');
  });

  test('order.paid followed by payment.captured for the same payment confirms once', async () => {
    const { booking, orderId } = await pendingBooking();
    const first = await deliver(gateway.webhook({ event: 'order.paid', orderId, paymentId: 'pay_same' }));
    const second = await deliver(gateway.webhook({ event: 'payment.captured', orderId, paymentId: 'pay_same' }));

    expect(first.body.result).toBe('CONFIRMED');
    expect(second.body.result).toBe('ALREADY_CONFIRMED');
    expect((await bookingRow(booking.id)).payment_id).toBe('pay_same');
  });

  test('an underpayment does not confirm the booking', async () => {
    const { booking, orderId } = await pendingBooking(10000);
    const res = await deliver(gateway.webhook({ orderId, paymentId: 'pay_low', amount: 5000 }));

    expect(res.body.result).toBe('AMOUNT_MISMATCH');
    expect((await bookingRow(booking.id)).status).toBe('PENDING');
  });
});

describe('duplicate and concurrent deliveries', () => {
  test('the same event delivered twice is processed once', async () => {
    const { orderId } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_dup' });

    expect((await deliver(w)).body.result).toBe('CONFIRMED');
    const again = await deliver(w);
    expect(again.status).toBe(200);
    expect(again.body.result).toBe('DUPLICATE');
    expect(await eventCount(w.eventId)).toBe(1);
  });

  test('10 parallel deliveries of one event: exactly one processes it', async () => {
    const { booking, orderId } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_race' });

    const results = await Promise.all(Array.from({ length: 10 }, () => deliver(w)));
    const outcomes = results.map((r) => r.body.result);

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(outcomes.filter((o) => o === 'CONFIRMED')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(9);
    expect(await eventCount(w.eventId)).toBe(1);
    expect((await bookingRow(booking.id)).status).toBe('CONFIRMED');
  });

  test('a failure while processing rolls back the dedupe record, so the redelivery is processed', async () => {
    const { booking, orderId } = await pendingBooking();
    const w = gateway.webhook({ orderId, paymentId: 'pay_retry' });
    jest.spyOn(payments, 'confirmBookingPayment').mockRejectedValueOnce(new Error('boom'));

    const first = await deliver(w);
    expect(first.status).toBe(500);
    expect(await eventCount(w.eventId)).toBe(0);
    expect((await bookingRow(booking.id)).status).toBe('PENDING');

    const second = await deliver(w);
    expect(second.status).toBe(200);
    expect(second.body.result).toBe('CONFIRMED');
  });
});

describe('payments that arrive in awkward situations', () => {
  test('a payment for an already closed booking is recorded once, never booked', async () => {
    const { seatId, booking, orderId } = await pendingBooking();
    await pool.query(
      "UPDATE bookings SET status = 'FAILED', failure_reason = 'STALE_PENDING_TIMEOUT' WHERE id = $1",
      [booking.id]
    );

    const late = await deliver(gateway.webhook({ orderId, paymentId: 'pay_late' }));
    expect(late.body.result).toBe('LATE_PAYMENT');
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'FAILED', failure_reason: 'LATE_PAYMENT', payment_id: 'pay_late' });
    expect((await seatRow(seatId)).status).toBe('LOCKED');

    const second = await deliver(gateway.webhook({ event: 'payment.captured', orderId, paymentId: 'pay_late' }));
    expect(second.body.result).toBe('ALREADY_RECORDED');
  });

  test('if someone else took the seat after the lock lapsed, the payment is recorded as SEAT_LOST_AFTER_PAYMENT', async () => {
    const { seatId, booking, orderId } = await pendingBooking();
    await pool.query("UPDATE seats SET locked_until = now() - interval '1 minute' WHERE id = $1", [seatId]);
    const other = await createUser();
    expect((await lockSeat(other.accessToken, seatId)).status).toBe(200);

    const res = await deliver(gateway.webhook({ orderId, paymentId: 'pay_lost' }));
    expect(res.body.result).toBe('SEAT_LOST');
    expect(await bookingRow(booking.id)).toMatchObject({ status: 'FAILED', failure_reason: 'SEAT_LOST_AFTER_PAYMENT', payment_id: 'pay_lost' });
    expect(await seatRow(seatId)).toMatchObject({ status: 'LOCKED', locked_by: other.id });
  });

  test('a paying user still gets the seat when the lock lapsed but nobody else took it', async () => {
    const { user, seatId, booking, orderId } = await pendingBooking();
    await pool.query(
      "UPDATE seats SET status = 'AVAILABLE', locked_by = NULL, locked_until = NULL WHERE id = $1",
      [seatId]
    );

    const res = await deliver(gateway.webhook({ orderId, paymentId: 'pay_free' }));
    expect(res.body.result).toBe('CONFIRMED');
    expect((await bookingRow(booking.id)).status).toBe('CONFIRMED');
    expect(await seatRow(seatId)).toMatchObject({ status: 'BOOKED', locked_by: user.id });
  });
});
