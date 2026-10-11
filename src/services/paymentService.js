const crypto = require('crypto');

const SIMULATED_LATENCY_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = { charges: 0, refunds: 0 }; 

// Mock gateway. A real adapter (e.g. Stripe) will expose the same charge/refund interface.
async function charge({ idempotencyKey, simulate }) {
     stats.charges += 1;  
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
    stats.refunds += 1;  
  console.log(`[mock-payment] refund ${paymentId}`);
}
function getStats() {
  return { ...stats };
}

module.exports = { charge, refund, getStats };