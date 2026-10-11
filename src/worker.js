require('dotenv').config();
const pool = require('./config/db');
const { startReconciler, INTERVAL_MS } = require('./jobs/reconciler');

async function main() {
  const reconciler = await startReconciler();
  console.log(`[worker] reconciler running every ${INTERVAL_MS}ms`);

  const shutdown = async (signal) => {
    console.log(`[worker] ${signal} received, shutting down`);
    await reconciler.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});