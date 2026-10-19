const pool = require('../config/db');

async function createEvent({ name, venue, eventTime, pricePaise }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO events (name, venue, event_time, price_paise)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [name, venue, eventTime, pricePaise]
  );
  return rows[0];
}

async function getEventById(eventId) {
  const { rows } = await pool.query('SELECT * FROM events WHERE id = $1', [eventId]);
  return rows[0] || null;
}

module.exports = { createEvent, getEventById };
