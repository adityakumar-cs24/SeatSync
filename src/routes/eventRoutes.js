const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');

router.post('/', eventController.createEvent);
router.get('/:eventId/seats', eventController.listSeats);

module.exports = router;