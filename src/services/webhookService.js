const pool = require('../config/db');
const payments = require('./paymentConfirmation');

const PAID_EVENTS = new Set(['order.paid', 'payment.captured']);

// Both event shapes carry the payment; order.paid also carries the order with amount_paid.
function extractPaid(event) {
  const payment = event?.payload?.payment?.entity;
  const order = event?.payload?.order?.entity;
  const orderId = order?.id || payment?.order_id;
  const paymentId = payment?.id;
  const amountPaid = order?.amount_paid ?? payment?.amount;
  if (!orderId || !paymentId || !Number.isInteger(amountPaid)) return null;
  return { orderId, paymentId, amountPaidPaise: amountPaid };
}

// The dedupe record and the business effect share one transaction. If processing fails, the record is
// rolled back with it, so the gateway's redelivery is processed instead of being skipped as a duplicate.
// Two parallel deliveries of the same event: the second INSERT waits for the first to commit, then conflicts.
async function processWebhook({ eventId, eventType, event }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const inserted = await client.query(
      'INSERT INTO webhook_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
      [eventId, eventType]
    );
    if (inserted.rowCount === 0) {
      await client.query('ROLLBACK');
      return { code: 'DUPLICATE' };
    }

    let result = { code: 'IGNORED' };
    if (PAID_EVENTS.has(eventType)) {
      const paid = extractPaid(event);
      if (paid) result = await payments.confirmBookingPayment(client, paid);
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processWebhook };
