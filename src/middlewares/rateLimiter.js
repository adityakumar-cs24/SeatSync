const { getApiRedis } = require('../config/redis');

// One round trip, atomic: increment the counter, start the window on the first hit, and report how
// long the window has left. Because it is a single script, concurrent requests can never both read
// "limit - 1" and both slip through.
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('PTTL', KEYS[1]) }
`;

function enabled() {
  if (process.env.RATE_LIMIT_FORCE === 'true') return true;   // rate limiter tests
  if (process.env.RATE_LIMIT_ENABLED === 'false') return false; // explicit switch off
  return process.env.NODE_ENV !== 'test';                      // off during the normal test suite
}

// name:   namespace, so one route's limit never eats another's
// limit:  allowed requests per window
// windowMs: window length
// keyFn:  (req) => string identifying who is being limited
function rateLimit({ name, limit, windowMs, keyFn }) {
  return async (req, res, next) => {
    if (!enabled()) return next();

    let count;
    let ttlMs;
    try {
      const key = `${process.env.RATE_LIMIT_PREFIX || 'rl'}:${name}:${keyFn(req)}`;
      [count, ttlMs] = await getApiRedis().eval(SCRIPT, 1, key, windowMs);
    } catch (err) {
      // Fail open: a broken rate limiter must not take the whole API down with it.
      console.warn(`[rate-limit] Redis unavailable, allowing request (${err.message})`);
      return next();
    }

    res.set('RateLimit-Limit', String(limit));
    res.set('RateLimit-Remaining', String(Math.max(0, limit - count)));

    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil(ttlMs / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests', retryAfterSeconds: retryAfter });
    }
    next();
  };
}

const ip = (req) => req.ip;

module.exports = { rateLimit, ip };
