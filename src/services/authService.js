const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { accessSecret, accessTtl, refreshTtlDays, bcryptCost } = require('../config/auth');
const userModel = require('../models/userModel');
const refreshTokenModel = require('../models/refreshTokenModel');

const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', bcryptCost);

function issueAccessToken(userId) {
  return jwt.sign({}, accessSecret, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: accessTtl,
  });
}

function verifyAccessToken(token) {
  return jwt.verify(token, accessSecret, { algorithms: ['HS256'] });
}

// 48 random bytes = 384 bits of entropy, so a fast hash is enough to protect it at rest.
function generateRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function register({ email, name, password }) {
  const passwordHash = await bcrypt.hash(password, bcryptCost);
  try {
    const user = await userModel.createUser({ email, name, passwordHash });
    return { user };
  } catch (err) {
    if (err.code === '23505') return { error: 'EMAIL_TAKEN' };
    throw err;
  }
}

async function login({ email, password }) {
  const user = await userModel.findByEmail(email);
  const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

  if (!user || !matches) return { error: 'INVALID_CREDENTIALS' };

  const refreshToken = generateRefreshToken();
  await refreshTokenModel.insert({
    userId: user.id,
    familyId: null,
    tokenHash: hashToken(refreshToken),
    ttlDays: refreshTtlDays,
  });

  return {
    user: { id: user.id, email: user.email, name: user.name },
    accessToken: issueAccessToken(user.id),
    refreshToken,
  };
}

// Rotation: the presented token is revoked and a new one is issued in the same transaction.
async function refresh(presentedToken) {
  const tokenHash = hashToken(presentedToken);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const used = await refreshTokenModel.revokeIfActive(tokenHash, client);
    if (used) {
      const newToken = generateRefreshToken();
      await refreshTokenModel.insert(
        {
          userId: used.user_id,
          familyId: used.family_id,
          tokenHash: hashToken(newToken),
          ttlDays: refreshTtlDays,
        },
        client
      );
      await client.query('COMMIT');
      return { accessToken: issueAccessToken(used.user_id), refreshToken: newToken };
    }

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Not active: unknown, expired, or already used. An already-used token being presented again
  // means two parties hold it (theft, or a replayed request), so the whole session is revoked.
  const existing = await refreshTokenModel.findByHash(tokenHash);
  if (existing && existing.revoked_at) {
    await refreshTokenModel.revokeFamily(existing.family_id);
    return { error: 'REUSE_DETECTED' };
  }
  return { error: 'INVALID' };
}

// Revokes the whole session (token family). Always succeeds so callers can't probe for valid tokens.
async function logout(presentedToken) {
  const existing = await refreshTokenModel.findByHash(hashToken(presentedToken));
  if (existing) await refreshTokenModel.revokeFamily(existing.family_id);
}

module.exports = { register, login, refresh, logout, issueAccessToken, verifyAccessToken };