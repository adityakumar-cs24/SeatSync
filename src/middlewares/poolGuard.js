const pool = require('../config/db');

// When requests are already queued for a database connection, one more request would only wait in
// line (up to the connection timeout) and then fail with a 500. Telling the client right away lets it
// back off and retry, and keeps the server from piling up work it cannot finish.
// POOL_GUARD_MAX_WAITING is the queue length tolerated before shedding (default 0).
function poolGuard(req, res, next) {
  const maxWaiting = parseInt(process.env.POOL_GUARD_MAX_WAITING || '0', 10);
  if (pool.waitingCount > maxWaiting) {
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Service busy, please retry shortly' });
  }
  next();
}

module.exports = poolGuard;
