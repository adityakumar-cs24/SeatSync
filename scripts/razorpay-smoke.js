require('dotenv').config();
const { loadPaymentConfig } = require('../src/config/payment');
const { createRazorpayClient } = require('../src/services/payment/razorpayClient');

// Creates a Rs 1 order in Razorpay TEST mode and reads it back. No money moves in test mode.
// It proves the keys work. Credentials are never printed.
async function main() {
  const config = loadPaymentConfig();
  const client = createRazorpayClient(config);

  const order = await client.createOrder({
    amountPaise: 100,
    receipt: `smoke-${Date.now()}`,
    notes: { purpose: 'smoke-test' },
  });
  console.log('created :', { id: order.id, amount: order.amount, currency: order.currency, status: order.status, receipt: order.receipt });

  const fetched = await client.fetchOrder(order.id);
  console.log('fetched :', { id: fetched.id, status: fetched.status, amount_paid: fetched.amount_paid, amount_due: fetched.amount_due });

  const payments = await client.fetchOrderPayments(order.id);
  console.log('payments:', Array.isArray(payments.items) ? payments.items.length : 'unexpected response shape');
}

main().catch((err) => {
  const detail = err.status ? ` (HTTP ${err.status}${err.code ? `, ${err.code}` : ''})` : '';
  console.error(`FAILED: ${err.message}${detail}`);
  process.exit(1);
});
