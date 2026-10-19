const crypto = require('crypto');
const { getPaymentGateway } = require('../services/payment');
const webhookService = require('../services/webhookService');

async function razorpayWebhook(req, res) {
  try {
    const raw = req.body;
    if (!Buffer.isBuffer(raw) || raw.length === 0) {
      return res.status(400).json({ error: 'Expected a raw JSON body' });
    }

    // Authenticity first: nothing in the body is trusted until the signature over the raw bytes matches.
    const signature = req.get('X-Razorpay-Signature');
    if (!signature || !getPaymentGateway().verifyWebhookSignature(raw, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Body is not valid JSON' });
    }

    const eventId = (req.get('x-razorpay-event-id') || crypto.createHash('sha256').update(raw).digest('hex')).slice(0, 128);
    const eventType = String(event.event || 'unknown').slice(0, 64);

    const result = await webhookService.processWebhook({ eventId, eventType, event });
    console.log(`[webhook] ${eventType} ${eventId} -> ${result.code}`);
    res.status(200).json({ received: true, result: result.code });
  } catch (err) {
    // A non-2xx makes the gateway redeliver, which is what we want after a transient failure.
    console.error('Error handling webhook:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { razorpayWebhook };
