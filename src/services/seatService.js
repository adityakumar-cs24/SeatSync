const pool = require('../config/db');

const LOCK_DURATION_MINUTES = 8;

// Single atomic UPDATE: only one concurrent caller can match the WHERE clause.
// Returns { seat } on success, or { error: 'NOT_FOUND' | 'UNAVAILABLE' }.
async function lockSeat(seatId, userId) {
  const { rows } = await pool.query(
    `UPDATE seats
     SET status = 'LOCKED',
         locked_by = $1,
         locked_until = NOW() + INTERVAL '${LOCK_DURATION_MINUTES} minutes'
     WHERE id = $2
       AND (
         status = 'AVAILABLE'
         OR (status = 'LOCKED' AND locked_until < NOW())
       )
     RETURNING id, status, locked_by, locked_until`,
    [userId, seatId]
  );

  if (rows.length > 0) {
    return { seat: rows[0] };
  }

  // Lock failed: distinguish "seat doesn't exist" from "seat is taken".
  const { rowCount } = await pool.query('SELECT 1 FROM seats WHERE id = $1', [seatId]);
  return { error: rowCount === 0 ? 'NOT_FOUND' : 'UNAVAILABLE' };
}

// Only the lock holder can release, and only while the seat is still LOCKED.
async function releaseSeat(seatId, userId) {
  const { rows } = await pool.query(
    `UPDATE seats
     SET status = 'AVAILABLE', locked_by = NULL, locked_until = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'LOCKED'
     RETURNING id, status`,
    [seatId, userId]
  );
  return rows[0] || null;
}

module.exports = { lockSeat, releaseSeat, LOCK_DURATION_MINUTES };