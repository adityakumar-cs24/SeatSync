const crypto = require('crypto');

const SIMULATED_LATENCY_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Mock gateway. A real adapter (e.g. Stripe) will expose the same charge/refund interface.
async function charge({ idempotencyKey, simulate }) {
  await sleep(SIMULATED_LATENCY_MS);

  if (simulate === 'fail' && process.env.NODE_ENV !== 'production') {
    console.log(`[mock-payment] charge key=${idempotencyKey} -> DECLINED`);
    return { success: false, reason: 'CARD_DECLINED' };
  }

  const paymentId = `mock_pay_${crypto.randomUUID()}`;
  console.log(`[mock-payment] charge key=${idempotencyKey} -> OK ${paymentId}`);
  return { success: true, paymentId };
}

async function refund(paymentId) {
  console.log(`[mock-payment] refund ${paymentId}`);
}

module.exports = { charge, refund };