const seatService = require('../services/seatService');
const { isUuid } = require('../utils/validators');

async function lockSeat(req, res) {
  try {
    const { seatId } = req.params;
    const { userId } = req.body ?? {};

    if (!isUuid(seatId) || !isUuid(userId)) {
      return res.status(400).json({ error: 'seatId and userId must be valid UUIDs' });
    }

    const result = await seatService.lockSeat(seatId, userId);

    if (result.error === 'NOT_FOUND') {
      return res.status(404).json({ error: 'Seat not found' });
    }
    if (result.error) {
      return res.status(409).json({ error: 'Seat is already locked or booked' });
    }

    res.status(200).json({ message: 'Seat locked successfully', seat: result.seat });
  } catch (err) {
    console.error('Error locking seat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function releaseSeat(req, res) {
  try {
    const { seatId } = req.params;
    const { userId } = req.body ?? {};

    if (!isUuid(seatId) || !isUuid(userId)) {
      return res.status(400).json({ error: 'seatId and userId must be valid UUIDs' });
    }

    const seat = await seatService.releaseSeat(seatId, userId);

    if (!seat) {
      return res.status(404).json({ error: 'No active lock held by this user on this seat' });
    }

    res.status(200).json({ message: 'Seat released', seat });
  } catch (err) {
    console.error('Error releasing seat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { lockSeat, releaseSeat };