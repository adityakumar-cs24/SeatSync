const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const authenticate = require('../middlewares/authenticate');
const { rateLimit, ip } = require('../middlewares/rateLimiter');

const MINUTE = 60 * 1000;

// Per IP and email, so one attacker cannot hammer a single account, and an office sharing one IP
// is not locked out because of a single bad actor guessing other people's addresses.
const loginLimiter = rateLimit({
  name: 'login',
  limit: 5,
  windowMs: 15 * MINUTE,
  keyFn: (req) => `${ip(req)}:${String(req.body?.email ?? '').trim().toLowerCase()}`,
});

// A broader cap per IP across all emails, against credential stuffing.
const loginIpLimiter = rateLimit({ name: 'login-ip', limit: 30, windowMs: 15 * MINUTE, keyFn: ip });
const registerLimiter = rateLimit({ name: 'register', limit: 10, windowMs: 60 * MINUTE, keyFn: ip });
const refreshLimiter = rateLimit({ name: 'refresh', limit: 30, windowMs: 15 * MINUTE, keyFn: ip });

router.post('/register', registerLimiter, authController.register);
router.post('/login', loginIpLimiter, loginLimiter, authController.login);
router.post('/refresh', refreshLimiter, authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', authenticate, authController.me);

module.exports = router;