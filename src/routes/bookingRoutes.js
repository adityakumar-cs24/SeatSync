const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const authenticate = require('../middlewares/authenticate');
const poolGuard = require('../middlewares/poolGuard');
const { rateLimit } = require('../middlewares/rateLimiter');

// Verifying costs a call to the gateway, so it is limited per user.
const verifyLimiter = rateLimit({ name: 'verify', limit: 20, windowMs: 60 * 1000, keyFn: (req) => req.user.id });

router.use(authenticate);

router.post('/', poolGuard, bookingController.createBooking);
router.post('/:bookingId/verify', verifyLimiter, bookingController.verifyPayment);
router.get('/:bookingId', bookingController.getBooking);

module.exports = router;
