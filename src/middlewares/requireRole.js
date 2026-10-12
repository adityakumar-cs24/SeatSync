const userModel = require('../models/userModel');

// Must run after authenticate. The role is read from the database on every call, not from the
// token, so demoting a user takes effect immediately instead of after the token expires.
function requireRole(role) {
  return async (req, res, next) => {
    try {
      const user = await userModel.findById(req.user.id);
      if (!user) return res.status(401).json({ error: 'User no longer exists' });
      if (user.role !== role) return res.status(403).json({ error: 'Insufficient permissions' });
      req.user.role = user.role;
      next();
    } catch (err) {
      console.error('Error checking role:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}

module.exports = requireRole;