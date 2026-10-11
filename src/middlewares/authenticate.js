const { verifyAccessToken } = require('../services/authService');

function authenticate(req, res, next) {
  const [scheme, token] = (req.get('Authorization') || '').split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    // A distinct code lets clients know when to use their refresh token (added in 11b).
    const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
    return res.status(401).json({ error: 'Invalid or expired token', code });
  }
}

module.exports = authenticate;