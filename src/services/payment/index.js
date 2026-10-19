const { loadPaymentConfig } = require('../../config/payment');
const { createRazorpayClient } = require('./razorpayClient');
const { verifyCheckoutSignature, verifyWebhookSignature } = require('./signatures');

let gateway;

function buildRazorpayGateway(config) {
  return {
    name: 'razorpay',
    publicKeyId: config.keyId, // safe to send to the browser; the secret never leaves the server
    paymentWindowMinutes: config.paymentWindowMinutes,
    ...createRazorpayClient(config),
    verifyCheckoutSignature: (args) => verifyCheckoutSignature(args, config.keySecret),
    verifyWebhookSignature: (rawBody, signature) =>
      verifyWebhookSignature(rawBody, signature, config.webhookSecret),
  };
}

// The rest of the application talks to this object, never to Razorpay directly.
function getPaymentGateway() {
  if (!gateway) {
    if (process.env.NODE_ENV === 'test') {
      throw new Error('No payment gateway is installed in tests. Call setPaymentGateway(fake) so tests never reach the real Razorpay.');
    }
    gateway = buildRazorpayGateway(loadPaymentConfig());
  }
  return gateway;
}

// Tests install a fake gateway here; passing null removes it.
function setPaymentGateway(replacement) {
  gateway = replacement || undefined;
}

module.exports = { getPaymentGateway, setPaymentGateway };
