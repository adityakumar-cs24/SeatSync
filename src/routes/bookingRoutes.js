const express = require('express');
const router = express.Router();
const bookingController = require('../controllers/bookingController');
const authenticate = require('../middlewares/authenticate');

router.use(authenticate);

router.post('/', bookingController.createBooking);
router.get('/:bookingId', bookingController.getBooking);

module.exports = router;