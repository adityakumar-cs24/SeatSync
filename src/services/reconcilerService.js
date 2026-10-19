const pool = require('../config/db');

const STALE_PENDING_SECONDS = parseInt(process.env.STALE_PENDING_SECONDS || '300', 10);

// A PENDING booking older than the threshold has no live request behind it (server crashed
// between phase 1 and phase 3). Failing it frees the seat for a new attempt.
async function failStalePendingBookings() {
  const { rows } = await pool.query(
    `UPDATE bookings
     SET status = 'FAILED', failure_reason = 'STALE_PENDING_TIMEOUT', updated_at = NOW()
     WHERE status = 'PENDING'
       AND COALESCE(expires_at, created_at + make_interval(secs => $1)) < NOW()
     RETURNING id, seat_id`,
    [STALE_PENDING_SECONDS]
  );
  return rows;
}

// Seats with a payment still in flight are skipped. The WHERE clause is re-evaluated under the
// row lock, so a concurrent lockSeat() that just re-claimed the seat is never overwritten.
async function releaseExpiredLocks() {
  const { rows } = await pool.query(
    `UPDATE seats s
     SET status = 'AVAILABLE', locked_by = NULL, locked_until = NULL
     WHERE s.status = 'LOCKED'
       AND s.locked_until < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM bookings b WHERE b.seat_id = s.id AND b.status = 'PENDING'
       )
     RETURNING s.id`
  );
  return rows;
}

async function runReconciliation() {
  // Order matters: failing stale bookings first lets their expired seats be released in the same run.
  const failedBookings = await failStalePendingBookings();
  const releasedSeats = await releaseExpiredLocks();

  if (failedBookings.length > 0 || releasedSeats.length > 0) {
    console.log(
      `[reconciler] failed ${failedBookings.length} stale pending booking(s), ` +
      `released ${releasedSeats.length} expired lock(s)`
    );
  }
  return { failedBookings: failedBookings.length, releasedSeats: releasedSeats.length };
}

module.exports = { runReconciliation };