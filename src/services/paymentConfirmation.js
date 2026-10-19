const pool = require('../config/db');

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Turns a paid gateway order into a confirmed booking. The caller owns the transaction (client), so the
// webhook path can make this and its dedupe record one atomic unit. Safe to call any number of times and
// from several paths at once (webhook, checkout verify, reconciler): the outcome is decided by booking state.
async function confirmBookingPayment(client, { orderId, paymentId, amountPaidPaise }) {
  const found = await client.query('SELECT id, seat_id FROM bookings WHERE gateway_order_id = $1', [orderId]);
  if (found.rowCount === 0) return { code: 'UNKNOWN_ORDER' };

  // Lock order is always seat first, then booking (the reservation does the same), so paths cannot deadlock.
  await client.query('SELECT id FROM seats WHERE id = $1 FOR UPDATE', [found.rows[0].seat_id]);
  const { rows } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [found.rows[0].id]);
  const booking = rows[0];

  if (booking.status === 'CONFIRMED') return { code: 'ALREADY_CONFIRMED', booking };

  // Paying less than the price never earns the seat.
  if (amountPaidPaise < booking.amount_paise) return { code: 'AMOUNT_MISMATCH', booking };

  if (booking.status === 'FAILED') {
    // The attempt was closed (expired, cancelled, seat lost) before this money arrived. Record the payment
    // once so it can be refunded; never overwrite an earlier outcome.
    if (booking.payment_id) return { code: 'ALREADY_RECORDED', booking };
    const closed = await client.query(
      `UPDATE bookings SET payment_id = $2, failure_reason = 'LATE_PAYMENT', updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [booking.id, paymentId]
    );
    return { code: 'LATE_PAYMENT', booking: closed.rows[0] };
  }

  // PENDING: the user keeps the seat if they still hold the lock, or if the lock lapsed and nobody took it.
  const seat = await client.query(
    `UPDATE seats SET status = 'BOOKED', locked_by = $2, locked_until = NULL
     WHERE id = $1 AND (status = 'AVAILABLE' OR (status = 'LOCKED' AND locked_by = $2))
     RETURNING id`,
    [booking.seat_id, booking.user_id]
  );

  if (seat.rowCount === 0) {
    const lost = await client.query(
      `UPDATE bookings SET status = 'FAILED', failure_reason = 'SEAT_LOST_AFTER_PAYMENT', payment_id = $2, updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [booking.id, paymentId]
    );
    return { code: 'SEAT_LOST', booking: lost.rows[0] };
  }

  const confirmed = await client.query(
    `UPDATE bookings SET status = 'CONFIRMED', payment_id = $2, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [booking.id, paymentId]
  );
  return { code: 'CONFIRMED', booking: confirmed.rows[0] };
}

module.exports = { withTransaction, confirmBookingPayment };
