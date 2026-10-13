require('dotenv').config();
const IORedis = require('ioredis');

// BullMQ workers require maxRetriesPerRequest: null (they block on Redis commands).
function createRedisConnection() {
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[redis] connection error:', err.message));
  return connection;
}

// Shared client for the API's rate limiter. Unlike the worker's connection it must fail fast:
// when Redis is down a request must not hang, it falls through (see rateLimiter).
let apiClient;
function getApiRedis() {
  if (!apiClient) {
    apiClient = new IORedis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      commandTimeout: 500,
    });
    apiClient.on('error', () => {}); // errors surface as rejected commands, handled by the limiter
  }
  return apiClient;
}

async function closeApiRedis() {
  if (apiClient) {
    await apiClient.quit().catch(() => apiClient.disconnect());
    apiClient = undefined;
  }
}

module.exports = { createRedisConnection, getApiRedis, closeApiRedis };