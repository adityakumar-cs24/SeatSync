const express = require('express');
const router = express.Router();
const eventController = require('../controllers/eventController');
const authenticate = require('../middlewares/authenticate');
const requireRole = require('../middlewares/requireRole');

router.post('/', authenticate, requireRole('admin'), eventController.createEvent);
router.get('/:eventId/seats', eventController.listSeats);

module.exports = router;