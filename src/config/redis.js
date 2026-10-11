require('dotenv').config();
const IORedis = require('ioredis');

// BullMQ workers require maxRetriesPerRequest: null (they block on Redis commands).
function createRedisConnection() {
  const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  connection.on('error', (err) => console.error('[redis] connection error:', err.message));
  return connection;
}

module.exports = { createRedisConnection };