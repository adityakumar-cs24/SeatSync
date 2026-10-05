const eventModel = require('../models/eventModel');
const seatModel = require('../models/seatModel');

async function createEvent(req, res) {
  try {
    const { name, venue, eventTime, totalSeats } = req.body;

    if (!name || !eventTime || !totalSeats) {
      return res.status(400).json({ error: 'name, eventTime, and totalSeats are required' });
    }

    const event = await eventModel.createEvent({ name, venue, eventTime });

    // Auto-generate seat numbers: A1, A2, A3...
    const seatNumbers = Array.from({ length: totalSeats }, (_, i) => `A${i + 1}`);
    const seats = await seatModel.createSeatsBulk(event.id, seatNumbers);

    res.status(201).json({ event, seats });
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function listSeats(req, res) {
  try {
    const { eventId } = req.params;
    const seats = await seatModel.getSeatsByEvent(eventId);
    res.status(200).json({ seats });
  } catch (err) {
    console.error('Error listing seats:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createEvent, listSeats };