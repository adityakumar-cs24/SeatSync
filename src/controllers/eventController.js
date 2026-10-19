const pool = require('../config/db');
const eventModel = require('../models/eventModel');
const seatModel = require('../models/seatModel');
const { isUuid } = require('../utils/validators');

const MAX_SEATS = 500;
const DEFAULT_PRICE_PAISE = 10000; // Rs 100
const MIN_PRICE_PAISE = 100; // the gateway minimum (Rs 1)
const MAX_PRICE_PAISE = 10000000; // Rs 1,00,000

async function createEvent(req, res) {
  const { name, venue, eventTime, totalSeats, pricePaise = DEFAULT_PRICE_PAISE } = req.body ?? {};

  if (!name || !eventTime || totalSeats === undefined) {
    return res.status(400).json({ error: 'name, eventTime, and totalSeats are required' });
  }
  if (!Number.isInteger(totalSeats) || totalSeats < 1 || totalSeats > MAX_SEATS) {
    return res.status(400).json({ error: `totalSeats must be an integer between 1 and ${MAX_SEATS}` });
  }
  if (Number.isNaN(Date.parse(eventTime))) {
    return res.status(400).json({ error: 'eventTime must be a valid date' });
  }

  if (!Number.isInteger(pricePaise) || pricePaise < MIN_PRICE_PAISE || pricePaise > MAX_PRICE_PAISE) {
    return res.status(400).json({ error: `pricePaise must be an integer between ${MIN_PRICE_PAISE} and ${MAX_PRICE_PAISE}` });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const event = await eventModel.createEvent({ name, venue, eventTime, pricePaise }, client);
    const seatNumbers = Array.from({ length: totalSeats }, (_, i) => `A${i + 1}`);
    const seats = await seatModel.createSeatsBulk(event.id, seatNumbers, client);
    await client.query('COMMIT');
    res.status(201).json({ event, seats });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating event:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
}

async function listSeats(req, res) {
  try {
    const { eventId } = req.params;
    if (!isUuid(eventId)) {
      return res.status(400).json({ error: 'Invalid eventId' });
    }
    const event = await eventModel.getEventById(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const seats = await seatModel.getSeatsByEvent(eventId);
    res.status(200).json({ seats });
  } catch (err) {
    console.error('Error listing seats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createEvent, listSeats };