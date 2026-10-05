const pool = require('../config/db');

async function createEvent({ name, venue, eventTime }) {
  const query = `
    INSERT INTO events (name, venue, event_time)
    VALUES ($1, $2, $3)
    RETURNING *;
  `;
  const { rows } = await pool.query(query, [name, venue, eventTime]);
  return rows[0];
}

async function getEventById(eventId) {
  const { rows } = await pool.query(
    'SELECT * FROM events WHERE id = $1',
    [eventId]
  );
  return rows[0] || null;
}

module.exports = { createEvent, getEventById };