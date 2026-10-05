const seatService = require('../services/seatService');

async function lockSeat(req, res) {
  try {
    const { seatId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const result = await seatService.lockSeat(seatId, userId);

    if (!result) {
      return res.status(409).json({ error: 'Seat is already locked or booked' });
    }

    res.status(200).json({ message: 'Seat locked successfully', seat: result });
  } catch (err) {
    console.error('Error locking seat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function releaseSeat(req, res) {
  try {
    const { seatId } = req.params;
    const { userId } = req.body;

    const result = await seatService.releaseSeat(seatId, userId);

    if (!result) {
      return res.status(404).json({ error: 'Seat not found or not locked by this user' });
    }

    res.status(200).json({ message: 'Seat released', seat: result });
  } catch (err) {
    console.error('Error releasing seat:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { lockSeat, releaseSeat };