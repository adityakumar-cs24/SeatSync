const express = require('express');
const router = express.Router();
const seatController = require('../controllers/seatController');
const authenticate = require('../middlewares/authenticate');

router.post('/:seatId/lock', authenticate, seatController.lockSeat);
router.post('/:seatId/release', authenticate, seatController.releaseSeat);

module.exports = router;