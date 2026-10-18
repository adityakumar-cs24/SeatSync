const crypto = require('crypto');

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

// Constant-time comparison. timingSafeEqual throws on different lengths, so check that first.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Signature Razorpay Checkout returns to the browser: HMAC-SHA256 of "order_id|payment_id"
// keyed with the API key secret.
function verifyCheckoutSignature({ orderId, paymentId, signature }, keySecret) {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

// Webhook signature: HMAC-SHA256 of the exact raw request body keyed with the webhook secret.
// A body that was parsed and re-serialised will not match, so callers must pass the raw bytes.
function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!webhookSecret) throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured');
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;
  return safeEqual(hmacHex(webhookSecret, rawBody), signature);
}

module.exports = { verifyCheckoutSignature, verifyWebhookSignature };
