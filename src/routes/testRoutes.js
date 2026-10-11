const express = require('express');
const paymentService = require('../services/paymentService');

const router = express.Router();

// Test aid for load tests. Counters are in-memory and per process, so this is not a metrics system.
router.get('/payment-stats', (req, res) => {
  res.status(200).json(paymentService.getStats());
});

module.exports = router;