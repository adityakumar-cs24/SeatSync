const bookingService = require('../services/bookingService');
const { isUuid } = require('../utils/validators');

function sendResult(res, { code, booking, replayed }) {
  if (replayed) res.set('Idempotent-Replayed', 'true');

  switch (code) {
    case 'CONFIRMED':
      return res.status(replayed ? 200 : 201).json({ booking });
    case 'IN_PROGRESS':
      return res.status(202).json({ message: 'Payment is still being processed', booking });
    case 'PAYMENT_FAILED':
      return res.status(402).json({ error: 'Payment failed', reason: booking.failure_reason, booking });
    case 'SEAT_NOT_FOUND':
      return res.status(404).json({ error: 'Seat not found' });
    case 'LOCK_NOT_HELD':
      return res.status(409).json({ error: 'You do not hold an active lock on this seat' });
    case 'PAYMENT_IN_PROGRESS':
      return res.status(409).json({ error: 'A payment for this seat is already in progress' });
    case 'SEAT_LOST':
      return res.status(409).json({ error: 'Seat was lost during payment. Payment refunded', booking });
    case 'KEY_REUSED':
      return res.status(422).json({ error: 'Idempotency-Key was already used for a different request' });
    default:
      return res.status(500).json({ error: 'Internal server error' });
  }
}

async function createBooking(req, res) {
  try {
    const idempotencyKey = req.get('Idempotency-Key');
    const { seatId, userId, simulate } = req.body ?? {};

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return res.status(400).json({ error: 'Idempotency-Key header is required (8-255 characters)' });
    }
    if (!isUuid(seatId) || !isUuid(userId)) {
      return res.status(400).json({ error: 'seatId and userId must be valid UUIDs' });
    }
    if (simulate !== undefined && simulate !== 'fail') {
      return res.status(400).json({ error: "simulate, if provided, must be 'fail'" });
    }

    const result = await bookingService.createBooking({
      seatId: seatId.toLowerCase(),
      userId: userId.toLowerCase(),
      idempotencyKey,
      simulate,
    });
    return sendResult(res, result);
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function getBooking(req, res) {
  try {
    const { bookingId } = req.params;
    if (!isUuid(bookingId)) {
      return res.status(400).json({ error: 'Invalid bookingId' });
    }
    const booking = await bookingService.getBookingById(bookingId);
    if (!booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.status(200).json({ booking });
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createBooking, getBooking };