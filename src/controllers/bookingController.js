const bookingService = require('../services/bookingService');
const { isUuid } = require('../utils/validators');

function sendCreateResult(res, { code, booking, payment, replayed }) {
  if (replayed) res.set('Idempotent-Replayed', 'true');

  switch (code) {
    case 'PAYMENT_REQUIRED':
      return res.status(replayed ? 200 : 201).json({ booking, payment });
    case 'CONFIRMED':
      return res.status(200).json({ booking });
    case 'IN_PROGRESS':
      return res.status(202).json({ message: 'The payment order is still being created', booking });
    case 'PAYMENT_FAILED':
      return res
        .status(booking.failure_reason === 'GATEWAY_ERROR' ? 502 : 402)
        .json({ error: 'This booking attempt did not go through', reason: booking.failure_reason, booking });
    case 'GATEWAY_ERROR':
      return res.status(502).json({ error: 'The payment gateway is unavailable, please try again', reason: 'GATEWAY_ERROR' });
    case 'BOOKING_CLOSED':
      return res.status(409).json({ error: 'This booking expired, please start again' });
    case 'SEAT_NOT_FOUND':
      return res.status(404).json({ error: 'Seat not found' });
    case 'LOCK_NOT_HELD':
      return res.status(409).json({ error: 'You do not hold an active lock on this seat' });
    case 'PAYMENT_IN_PROGRESS':
      return res.status(409).json({ error: 'A payment for this seat is already in progress' });
    case 'KEY_REUSED':
      return res.status(422).json({ error: 'Idempotency-Key was already used for a different request' });
    default:
      return res.status(500).json({ error: 'Internal server error' });
  }
}

async function createBooking(req, res) {
  try {
    const idempotencyKey = req.get('Idempotency-Key');
    const { seatId } = req.body ?? {};

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 255) {
      return res.status(400).json({ error: 'Idempotency-Key header is required (8-255 characters)' });
    }
    if (!isUuid(seatId)) {
      return res.status(400).json({ error: 'seatId must be a valid UUID' });
    }

    const result = await bookingService.createBooking({
      seatId: seatId.toLowerCase(),
      userId: req.user.id,
      idempotencyKey,
    });
    return sendCreateResult(res, result);
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function verifyPayment(req, res) {
  try {
    const { bookingId } = req.params;
    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body ?? {};

    if (!isUuid(bookingId)) {
      return res.status(400).json({ error: 'Invalid bookingId' });
    }
    const present = [orderId, paymentId, signature].every(
      (value) => typeof value === 'string' && value.length > 0 && value.length <= 256
    );
    if (!present) {
      return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
    }

    const result = await bookingService.verifyCheckout({
      bookingId,
      userId: req.user.id,
      orderId,
      paymentId,
      signature,
    });

    switch (result.code) {
      case 'CONFIRMED':
      case 'ALREADY_CONFIRMED':
        return res.status(200).json({ booking: result.booking });
      case 'PAYMENT_PENDING':
      case 'AMOUNT_MISMATCH':
        return res.status(202).json({
          message: 'The payment is not confirmed yet. The booking is confirmed automatically once the gateway reports it.',
          booking: result.booking,
        });
      case 'SEAT_LOST':
      case 'LATE_PAYMENT':
      case 'ALREADY_RECORDED':
        return res.status(409).json({
          error: 'The seat could not be booked for this payment',
          reason: result.booking?.failure_reason,
          booking: result.booking,
        });
      case 'NOT_FOUND':
        return res.status(404).json({ error: 'Booking not found' });
      case 'INVALID':
        return res.status(400).json({ error: 'Payment verification failed' });
      case 'GATEWAY_UNAVAILABLE':
        return res.status(502).json({ error: 'Could not reach the payment gateway; the booking is confirmed automatically if the payment went through' });
      default:
        return res.status(500).json({ error: 'Internal server error' });
    }
  } catch (err) {
    console.error('Error verifying payment:', err);
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

    // Someone else's booking looks exactly like a missing one, so ids can't be probed.
    if (!booking || booking.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Booking not found' });
    }
    res.status(200).json({ booking });
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { createBooking, verifyPayment, getBooking };
