require('dotenv').config();

const TEST_KEY_PREFIX = 'rzp_test_';

// Read lazily (when the gateway is first used), not at import time, so the server still starts
// without payment keys while the booking flow does not need them.
function loadPaymentConfig(env = process.env) {
  const keyId = env.RAZORPAY_KEY_ID;
  const keySecret = env.RAZORPAY_KEY_SECRET;

  const missing = [];
  if (!keyId) missing.push('RAZORPAY_KEY_ID');
  if (!keySecret) missing.push('RAZORPAY_KEY_SECRET');
  if (missing.length > 0) {
    throw new Error(`Razorpay is not configured: set ${missing.join(' and ')} in .env`);
  }

  // This project only ever talks to Razorpay test mode unless someone opts in explicitly.
  if (!keyId.startsWith(TEST_KEY_PREFIX) && env.ALLOW_LIVE_PAYMENTS !== 'true') {
    throw new Error('Refusing to use a Razorpay key that is not a test key (expected the rzp_test_ prefix)');
  }

  const paymentWindowMinutes = parseInt(env.PAYMENT_WINDOW_MINUTES || '10', 10);
  if (!Number.isInteger(paymentWindowMinutes) || paymentWindowMinutes < 1) {
    throw new Error('PAYMENT_WINDOW_MINUTES must be a positive integer');
  }

  return Object.freeze({
    keyId,
    keySecret,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET || null,
    paymentWindowMinutes,
  });
}

module.exports = { loadPaymentConfig };
