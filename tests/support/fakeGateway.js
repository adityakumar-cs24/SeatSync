const crypto = require('crypto');
const { GatewayError } = require('../../src/services/payment/razorpayClient');
const { verifyCheckoutSignature, verifyWebhookSignature } = require('../../src/services/payment/signatures');

const hmac = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// An in-memory stand-in for Razorpay. It uses the REAL signature code with fake secrets, so tests exercise
// the verification the application actually runs. The latency makes concurrent requests overlap.
function createFakeGateway({ keySecret = 'fake-key-secret', webhookSecret = 'fake-webhook-secret', latencyMs = 25 } = {}) {
  const orders = new Map();
  const calls = { createOrder: 0, fetchOrder: 0 };
  let nextCreateError = null;
  let sequence = 0;

  return {
    name: 'fake',
    publicKeyId: 'rzp_test_fakekey',
    paymentWindowMinutes: 10,
    calls,
    orders,

    async createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
      calls.createOrder += 1;
      await sleep(latencyMs);
      if (nextCreateError) {
        const error = nextCreateError;
        nextCreateError = null;
        throw error;
      }
      sequence += 1;
      const id = `order_fake_${sequence}_${crypto.randomBytes(4).toString('hex')}`;
      const order = {
        id, entity: 'order', amount: amountPaise, amount_paid: 0, amount_due: amountPaise,
        currency, receipt, notes, status: 'created',
      };
      orders.set(id, order);
      return { ...order };
    },

    async fetchOrder(orderId) {
      calls.fetchOrder += 1;
      const order = orders.get(orderId);
      if (!order) throw new GatewayError('The id provided does not exist', { status: 400, code: 'BAD_REQUEST_ERROR' });
      return { ...order };
    },

    async fetchOrderPayments() {
      return { items: [] };
    },

    verifyCheckoutSignature: (args) => verifyCheckoutSignature(args, keySecret),
    verifyWebhookSignature: (rawBody, signature) => verifyWebhookSignature(rawBody, signature, webhookSecret),

    // ---- helpers for tests ----
    failNextCreateOrder(error = new GatewayError('Gateway unavailable', { status: 503, retryable: true })) {
      nextCreateError = error;
    },

    // Marks the order as paid (or partly paid) and returns the payment id.
    payOrder(orderId, { paymentId = `pay_fake_${crypto.randomBytes(5).toString('hex')}`, amount } = {}) {
      const order = orders.get(orderId);
      const paid = amount ?? order.amount;
      order.amount_paid = paid;
      order.amount_due = order.amount - paid;
      order.status = paid >= order.amount ? 'paid' : 'attempted';
      return paymentId;
    },

    checkoutSignature: (orderId, paymentId) => hmac(keySecret, `${orderId}|${paymentId}`),

    // A signed webhook delivery, as Razorpay would send it.
    webhook({ event = 'order.paid', orderId, paymentId, amount, eventId = `evt_${crypto.randomBytes(6).toString('hex')}` }) {
      const order = orders.get(orderId) || { amount: amount ?? 10000 };
      const paid = amount ?? order.amount;
      const body = JSON.stringify({
        entity: 'event',
        event,
        payload: {
          payment: { entity: { id: paymentId, order_id: orderId, amount: paid, status: 'captured' } },
          order: { entity: { id: orderId, amount: order.amount, amount_paid: paid, status: 'paid' } },
        },
      });
      return { body, eventId, signature: hmac(webhookSecret, body) };
    },
  };
}

module.exports = { createFakeGateway };
