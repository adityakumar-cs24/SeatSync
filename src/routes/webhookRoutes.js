const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');

// Raw body, not parsed JSON: the signature is computed over the exact bytes the gateway sent.
router.post('/razorpay', express.raw({ type: '*/*', limit: '256kb' }), webhookController.razorpayWebhook);

module.exports = router;
