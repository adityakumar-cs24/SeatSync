const express = require('express');
const router = express.Router();
const seatController = require('../controllers/seatController');
const authenticate = require('../middlewares/authenticate');
const { rateLimit } = require('../middlewares/rateLimiter');

// Authenticated, so the limit is per user. It stops a script from hammering the lock endpoint.
const lockLimiter = rateLimit({
  name: 'lock',
  limit: 30,
  windowMs: 60 * 1000,
  keyFn: (req) => req.user.id,
});

router.post('/:seatId/lock', authenticate, lockLimiter, seatController.lockSeat);
router.post('/:seatId/release', authenticate, seatController.releaseSeat);

module.exports = router;