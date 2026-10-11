const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { accessSecret, accessTtl, bcryptCost } = require('../config/auth');
const userModel = require('../models/userModel');

// Compared against when the email is unknown, so "no such user" costs the same time as "wrong password".
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', bcryptCost);

function issueAccessToken(userId) {
  return jwt.sign({}, accessSecret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: accessTtl,
  });
}

// Algorithm is pinned: tokens with alg "none" or any other algorithm are rejected.
function verifyAccessToken(token) {
  return jwt.verify(token, accessSecret, { algorithms: ['HS256'] });
}

async function register({ email, name, password }) {
  const passwordHash = await bcrypt.hash(password, bcryptCost);
  try {
    const user = await userModel.createUser({ email, name, passwordHash });
    return { user };
  } catch (err) {
    // 23505 = unique violation. The DB constraint decides, so two concurrent signups can't both win.
    if (err.code === '23505') return { error: 'EMAIL_TAKEN' };
    throw err;
  }
}

async function login({ email, password }) {
  const user = await userModel.findByEmail(email);
  const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !matches) return { error: 'INVALID_CREDENTIALS' };

  return {
    user: { id: user.id, email: user.email, name: user.name },
    accessToken: issueAccessToken(user.id),
  };
}

module.exports = { register, login, issueAccessToken, verifyAccessToken };