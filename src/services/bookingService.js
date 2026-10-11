const pool = require('../config/db');
const paymentService = require('./paymentService');

async function findBookingByKey(idempotencyKey) {
  const { rows } = await pool.query(
    'SELECT * FROM bookings WHERE idempotency_key = $1',
    [idempotencyKey]
  );
  return rows[0] || null;
}

async function getBookingById(bookingId) {
  const { rows } = await pool.query('SELECT * FROM bookings WHERE id = $1', [bookingId]);
  return rows[0] || null;
}

// A key that already exists is a replay, unless it is being reused for a different request.
function replayResult(existing, { seatId, userId }) {
  if (existing.seat_id !== seatId || existing.user_id !== userId) {
    return { code: 'KEY_REUSED' };
  }
  const codeByStatus = { CONFIRMED: 'CONFIRMED', PENDING: 'IN_PROGRESS', FAILED: 'PAYMENT_FAILED' };
  return { code: codeByStatus[existing.status], booking: existing, replayed: true };
}

// PHASE 1: verify the caller holds an active lock and record a PENDING booking.
async function reserveForPayment({ seatId, userId, idempotencyKey }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Row lock serializes concurrent booking attempts on the same seat.
    const { rows: seatRows } = await client.query(
      `SELECT status, locked_by, (locked_until > NOW()) AS lock_active
       FROM seats WHERE id = $1 FOR UPDATE`,
      [seatId]
    );
    const seat = seatRows[0];

    if (!seat) {
      await client.query('ROLLBACK');
      return { code: 'SEAT_NOT_FOUND' };
    }

    const lockHeld =
      seat.status === 'LOCKED' && seat.locked_by === userId && seat.lock_active === true;

    if (!lockHeld) {
      await client.query('ROLLBACK');
      // A retry that raced with the original request may find the seat already BOOKED.
      const existing = await findBookingByKey(idempotencyKey);
      return existing
        ? replayResult(existing, { seatId, userId })
        : { code: 'LOCK_NOT_HELD' };
    }

    const { rows } = await client.query(
      `INSERT INTO bookings (seat_id, user_id, status, idempotency_key)
       VALUES ($1, $2, 'PENDING', $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [seatId, userId, idempotencyKey]
    );

    if (rows.length === 0) {
      // Same key was inserted by a concurrent request: treat as replay.
      await client.query('ROLLBACK');
      const existing = await findBookingByKey(idempotencyKey);
      return replayResult(existing, { seatId, userId });
    }

    await client.query('COMMIT');
    return { code: 'RESERVED', booking: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    // Different key, but a payment for this seat is already in flight.
    if (err.code === '23505' && err.constraint === 'idx_one_pending_booking_per_seat') {
      return { code: 'PAYMENT_IN_PROGRESS' };
    }
    throw err;
  } finally {
    client.release();
  }
}

// PHASE 3a: payment succeeded, convert the lock into a booking.
async function finalizeSuccess(booking, paymentId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only the lock holder can take the seat. Even if the lock timer ran out during payment,
    // the seat is still ours as long as nobody else claimed it.
    const seatUpdate = await client.query(
      `UPDATE seats SET status = 'BOOKED', locked_until = NULL
       WHERE id = $1 AND status = 'LOCKED' AND locked_by = $2`,
      [booking.seat_id, booking.user_id]
    );

    if (seatUpdate.rowCount === 0) {
      const { rows } = await client.query(
        `UPDATE bookings
         SET status = 'FAILED', failure_reason = 'SEAT_LOST_AFTER_PAYMENT',
             payment_id = $2, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [booking.id, paymentId]
      );
      await client.query('COMMIT');
      return { code: 'SEAT_LOST', booking: rows[0] };
    }

    const { rows } = await client.query(
      `UPDATE bookings
       SET status = 'CONFIRMED', payment_id = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [booking.id, paymentId]
    );
    await client.query('COMMIT');
    return { code: 'CONFIRMED', booking: rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// PHASE 3b: payment failed. Seat stays LOCKED so the user can retry with a new key.
async function markFailed(bookingId, reason) {
  const { rows } = await pool.query(
    `UPDATE bookings
     SET status = 'FAILED', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [bookingId, reason]
  );
  return rows[0];
}

async function createBooking({ seatId, userId, idempotencyKey, simulate }) {
  // Fast path: a known key never reaches the payment gateway again.
  const existing = await findBookingByKey(idempotencyKey);
  if (existing) return replayResult(existing, { seatId, userId });

  const reserved = await reserveForPayment({ seatId, userId, idempotencyKey });
  if (reserved.code !== 'RESERVED') return reserved;

  // PHASE 2: only the request that inserted the PENDING row ever gets here.
  let payment;
  try {
    payment = await paymentService.charge({ idempotencyKey, simulate });
  } catch (err) {
    console.error('Payment gateway error:', err);
    payment = { success: false, reason: 'PAYMENT_GATEWAY_ERROR' };
  }

  if (!payment.success) {
    const failed = await markFailed(reserved.booking.id, payment.reason);
    return { code: 'PAYMENT_FAILED', booking: failed, replayed: false };
  }

  const result = await finalizeSuccess(reserved.booking, payment.paymentId);
  if (result.code === 'SEAT_LOST') {
    await paymentService.refund(payment.paymentId);
  }
  return { ...result, replayed: false };
}

module.exports = { createBooking, getBookingById };