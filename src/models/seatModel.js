const pool = require('../config/db');

async function getSeatsByEvent(eventId) {
  const { rows } = await pool.query(
    `SELECT id, seat_number, status
     FROM seats
     WHERE event_id = $1
     ORDER BY length(seat_number), seat_number`,
    [eventId]
  );
  return rows;
}

async function createSeatsBulk(eventId, seatNumbers, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO seats (event_id, seat_number)
     SELECT $1, unnest($2::text[])
     RETURNING id, seat_number, status`,
    [eventId, seatNumbers]
  );
  return rows;
}

module.exports = { getSeatsByEvent, createSeatsBulk };