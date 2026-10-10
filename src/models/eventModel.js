const pool = require('../config/db');

async function createEvent({ name, venue, eventTime }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO events (name, venue, event_time)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [name, venue, eventTime]
  );
  return rows[0];
}

async function getEventById(eventId) {
  const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  return rows[0] || null;
}

module.exports = { createEvent, getEventById };