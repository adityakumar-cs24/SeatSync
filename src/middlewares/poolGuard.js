const pool = require('../config/db');

// When requests are already queued for a database connection, one more request would only wait in
// line (up to the connection timeout) and then fail with a 500. Telling the client right away lets it
// back off and retry, and keeps the server from piling up work it cannot finish.
function poolGuard(req, res, next) {
  if (pool.waitingCount > 0) {
    res.set('Retry-After', '1');
    return res.status(503).json({ error: 'Service busy, please retry shortly' });
  }
  next();
}

module.exports = poolGuard;