const pool = require('../config/db');

// A null familyId starts a new family (a fresh login). Expiry is computed by the database clock.
async function insert({ userId, familyId, tokenHash, ttlDays }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at)
     VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, NOW() + make_interval(days => $4))
     RETURNING id, family_id`,
    [userId, familyId, tokenHash, ttlDays]
  );
  return rows[0];
}

// Atomic: of N concurrent callers presenting the same token, exactly one gets a row back.
async function revokeIfActive(tokenHash, db = pool) {
  const { rows } = await db.query(
    `UPDATE refresh_tokens
     SET revoked_at = NOW()
     WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id, user_id, family_id`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function findByHash(tokenHash, db = pool) {
  const { rows } = await db.query(
    'SELECT id, user_id, family_id, revoked_at FROM refresh_tokens WHERE token_hash = $1',
    [tokenHash]
  );
  return rows[0] || null;
}

async function revokeFamily(familyId, db = pool) {
  await db.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId]
  );
}

module.exports = { insert, revokeIfActive, findByHash, revokeFamily };