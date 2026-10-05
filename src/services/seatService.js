const pool = require('../config/db');

const LOCK_DURATION_MINUTES = 8;

async function lockSeat(seatId, userId) {
  const query = `
    UPDATE seats
    SET status = 'LOCKED',
        locked_by = $1,
        locked_until = NOW() + INTERVAL '${LOCK_DURATION_MINUTES} minutes'
    WHERE id = $2
      AND (
        status = 'AVAILABLE'
        OR (status = 'LOCKED' AND locked_until < NOW())
      )
    RETURNING id, status, locked_by, locked_until;
  `;
  const { rows } = await pool.query(query, [userId, seatId]);

  if (rows.length === 0) {
    return null; // seat already locked by someone else, or booked
  }
  return rows[0];
}
async function releaseSeat(seatId, userId) {
  const query = `
    UPDATE seats
    SET status = 'AVAILABLE', locked_by = NULL, locked_until = NULL
    WHERE id = $1 AND locked_by = $2
    RETURNING id, status;
  `;
  const { rows } = await pool.query(query, [seatId, userId]);
  return rows[0] || null;
}

module.exports = { lockSeat, releaseSeat, LOCK_DURATION_MINUTES };
module.exports = { lockSeat, LOCK_DURATION_MINUTES };