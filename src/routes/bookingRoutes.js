const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const authenticate = require('../middlewares/authenticate');
const poolGuard = require('../middlewares/poolGuard');

router.use(authenticate);

router.post('/', poolGuard, bookingController.createBooking);
router.get('/:bookingId', bookingController.getBooking);

module.exports = router;