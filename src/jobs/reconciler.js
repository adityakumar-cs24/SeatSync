const { Queue, Worker } = require('bullmq');
const { createRedisConnection } = require('../config/redis');
const { runReconciliation } = require('../services/reconcilerService');

const QUEUE_NAME = 'reconciler';
const INTERVAL_MS = parseInt(process.env.RECONCILER_INTERVAL_MS || '30000', 10);

async function startReconciler() {
  // BullMQ recommends separate connections for the Queue and the Worker.
  const queueConnection = createRedisConnection();
  const workerConnection = createRedisConnection();

  const queue = new Queue(QUEUE_NAME, { connection: queueConnection });

  // upsert = idempotent: restarting (or running several workers) never duplicates the schedule.
  await queue.upsertJobScheduler(
    'reconcile-recurring',
    { every: INTERVAL_MS },
    { name: 'reconcile', opts: { removeOnComplete: 20, removeOnFail: 100 } }
  );

  const worker = new Worker(QUEUE_NAME, async () => runReconciliation(), {
    connection: workerConnection,
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    console.error(`[reconciler] job ${job?.id} failed:`, err.message);
  });

  async function close() {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  }

  return { close };
}

module.exports = { startReconciler, INTERVAL_MS };