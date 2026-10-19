const pool = require('../config/db');
const { getPaymentGateway } = require('./payment');
const payments = require('./paymentConfirmation');

// The seat stays locked a little past the payment window, so a slow webhook cannot lose the seat.
const LOCK_GRACE_MINUTES = 2;

async function findBookingByKey(idempotencyKey, db = pool) {
  const { rows } = await db.query('SELECT * FROM bookings WHERE idempotency_key = $1', [idempotencyKey]);
  return rows[0] || null;
}

async function getBookingById(bookingId) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  return rows[0] || null;
}

function paymentDetails(booking) {
  return {
    orderId: booking.gateway_order_id,
    amount: booking.amount_paise,
    currency: booking.currency,
    keyId: getPaymentGateway().publicKeyId,
    expiresAt: booking.expires_at,
  };
}

// A key that already exists is a replay, unless it is being reused for a different request.
function replayResult(existing, { seatId, userId }) {
  if (existing.seat_id !== seatId || existing.user_id !== userId) return { code: 'KEY_REUSED' };

  switch (existing.status) {
    case 'CONFIRMED':
      return { code: 'CONFIRMED', booking: existing, replayed: true };
    case 'FAILED':
      return { code: 'PAYMENT_FAILED', booking: existing, replayed: true };
    default: // PENDING: hand back the same order, never create a second one
      return existing.gateway_order_id
        ? { code: 'PAYMENT_REQUIRED', booking: existing, payment: paymentDetails(existing), replayed: true }
        : { code: 'IN_PROGRESS', booking: existing, replayed: true };
  }
}

// PHASE 1: verify the caller holds an active lock, record a PENDING booking priced from the event.
async function reserveForPayment({ seatId, userId, idempotencyKey }) {
  const windowMinutes = getPaymentGateway().paymentWindowMinutes;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The row lock serializes concurrent booking attempts on the same seat.
    const { rows: seatRows } = await client.query(
      `SELECT s.status, s.locked_by, (s.locked_until > NOW()) AS lock_active, e.price_paise
       FROM seats s JOIN events e ON e.id = s.event_id
       WHERE s.id = $1 FOR UPDATE OF s`,
      [seatId]
    );
    const seat = seatRows[0];

    if (!seat) {
      await client.query('ROLLBACK');
      return { code: 'SEAT_NOT_FOUND' };
    }

    const lockHeld = seat.status === 'LOCKED' && seat.locked_by === userId && seat.lock_active === true;
    if (!lockHeld) {
      await client.query('ROLLBACK');
      const existing = await findBookingByKey(idempotencyKey, client);
      return existing ? replayResult(existing, { seatId, userId }) : { code: 'LOCK_NOT_HELD' };
    }

    const { rows } = await client.query(
      `INSERT INTO bookings (seat_id, user_id, status, idempotency_key, amount_paise, currency, expires_at)
       VALUES ($1, $2, 'PENDING', $3, $4, 'INR', NOW() + make_interval(mins => $5))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [seatId, userId, idempotencyKey, seat.price_paise, windowMinutes]
    );

    if (rows.length === 0) {
      // The same key was inserted by a concurrent request: treat this one as a replay.
      await client.query('ROLLBACK');
      const existing = await findBookingByKey(idempotencyKey, client);
      return replayResult(existing, { seatId, userId });
    }

    await client.query(
      `UPDATE seats
       SET locked_until = GREATEST(locked_until, $2::timestamptz + make_interval(mins => $3))
       WHERE id = $1`,
      [seatId, rows[0].expires_at, LOCK_GRACE_MINUTES]
    );

    await client.query('COMMIT');
    return { code: 'RESERVED', booking: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    // A different key, but a payment for this seat is already in flight.
    if (err.code === '23505' && err.constraint === 'idx_one_pending_booking_per_seat') {
      return { code: 'PAYMENT_IN_PROGRESS' };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function attachOrder(bookingId, orderId) {
  const { rows } = await pool.query(
    `UPDATE bookings SET gateway_order_id = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING *`,
    [bookingId, orderId]
  );
  return rows[0] || null;
}

async function markFailed(bookingId, reason) {
  const { rows } = await pool.query(
    `UPDATE bookings SET status = 'FAILED', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING' RETURNING *`,
    [bookingId, reason]
  );
  return rows[0] || null;
}

async function createBooking({ seatId, userId, idempotencyKey }) {
  // Fast path: a known key never creates a second order.
  const existing = await findBookingByKey(idempotencyKey);
  if (existing) return replayResult(existing, { seatId, userId });

  const reserved = await reserveForPayment({ seatId, userId, idempotencyKey });
  if (reserved.code !== 'RESERVED') return reserved;
  const { booking } = reserved;

  // PHASE 2, outside any DB transaction: only the request that inserted the PENDING row gets here.
  let order;
  try {
    order = await getPaymentGateway().createOrder({
      amountPaise: booking.amount_paise,
      currency: booking.currency,
      receipt: booking.id,
      notes: { bookingId: booking.id, seatId: booking.seat_id },
    });
  } catch (err) {
    console.error('Gateway order creation failed:', err.message);
    await markFailed(booking.id, 'GATEWAY_ERROR');
    return { code: 'GATEWAY_ERROR' };
  }

  // PHASE 3: remember the order. The money itself is confirmed later (webhook or checkout verify).
  const updated = await attachOrder(booking.id, order.id);
  if (!updated) return { code: 'BOOKING_CLOSED' };
  return { code: 'PAYMENT_REQUIRED', booking: updated, payment: paymentDetails(updated), replayed: false };
}

// Called by the browser after Checkout. The signature only proves the browser got these ids from Razorpay;
// the order status is then read from Razorpay's API before anything is confirmed.
async function verifyCheckout({ bookingId, userId, orderId, paymentId, signature }) {
  const booking = await getBookingById(bookingId);
  if (!booking || booking.user_id !== userId) return { code: 'NOT_FOUND' };
  if (!booking.gateway_order_id || booking.gateway_order_id !== orderId) return { code: 'INVALID' };

  const gateway = getPaymentGateway();
  if (!gateway.verifyCheckoutSignature({ orderId, paymentId, signature })) return { code: 'INVALID' };

  if (booking.status === 'CONFIRMED') return { code: 'CONFIRMED', booking };

  let order;
  try {
    order = await gateway.fetchOrder(orderId);
  } catch (err) {
    console.error('Gateway order fetch failed:', err.message);
    return { code: 'GATEWAY_UNAVAILABLE' };
  }

  if (order.status !== 'paid' || order.amount_paid < booking.amount_paise) {
    return { code: 'PAYMENT_PENDING', booking };
  }

  return payments.withTransaction((client) =>
    payments.confirmBookingPayment(client, { orderId, paymentId, amountPaidPaise: order.amount_paid })
  );
}

module.exports = { createBooking, verifyCheckout, getBookingById };
