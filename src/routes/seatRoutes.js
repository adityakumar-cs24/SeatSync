const express = require('express');
const router = express.Router();
const seatController = require('../controllers/seatController');

router.post('/:seatId/lock', seatController.lockSeat);
router.post('/:seatId/release', seatController.releaseSeat);

module.exports = router;