const pool = require('../config/db');

async function getSeatsByEvent(eventId) {
  const { rows } = await pool.query(
    'SELECT id, seat_number, status FROM seats WHERE event_id = $1 ORDER BY seat_number',
    [eventId]
  );
  return rows;
}

async function createSeatsBulk(eventId, seatNumbers) {
  // Bulk insert - ek event ke liye multiple seats ek saath banana
  const values = seatNumbers.map((num, i) => `($1, $${i + 2})`).join(', ');
  const query = `
    INSERT INTO seats (event_id, seat_number)
    VALUES ${values}
    RETURNING id, seat_number, status;
  `;
  const { rows } = await pool.query(query, [eventId, ...seatNumbers]);
  return rows;
}

module.exports = { getSeatsByEvent, createSeatsBulk };