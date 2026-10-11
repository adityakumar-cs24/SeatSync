require('dotenv').config();
const pool = require('./config/db');
const { startReconciler, INTERVAL_MS } = require('./jobs/reconciler');

async function main() {
  const reconciler = await startReconciler();
  console.log(`[worker] reconciler running every ${INTERVAL_MS}ms`);

  let shuttingDown = false;

  // Idempotent: npm and the terminal can both deliver SIGINT, so this may be called twice.
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[worker] ${signal} received, shutting down`);
    try {
      await reconciler.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error('[worker] error during shutdown:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});