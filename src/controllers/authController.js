const authService = require('../services/authService');
const userModel = require('../models/userModel');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignores everything after 72 bytes

function validateRegistration({ email, name, password }) {
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 255) {
    return 'A valid email is required';
  }
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 100) {
    return 'name is required (1-100 characters)';
  }
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return null;
}

async function register(req, res) {
  try {
    const { email, name, password } = req.body ?? {};

    const problem = validateRegistration({ email, name, password });
    if (problem) return res.status(400).json({ error: problem });

    const result = await authService.register({
      email: email.trim().toLowerCase(),
      name: name.trim(),
      password,
    });

    if (result.error === 'EMAIL_TAKEN') {
      return res.status(409).json({ error: 'Email is already registered' });
    }
    res.status(201).json({ user: result.user });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body ?? {};

    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const result = await authService.login({ email: email.trim().toLowerCase(), password });

    if (result.error) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    res.status(200).json({
      user: result.user,
      accessToken: result.accessToken,
      tokenType: 'Bearer',
    });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

async function me(req, res) {
  try {
    const user = await userModel.findById(req.user.id);
    if (!user) return res.status(401).json({ error: 'User no longer exists' });
    res.status(200).json({ user });
  } catch (err) {
    console.error('Error fetching current user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { register, login, me };