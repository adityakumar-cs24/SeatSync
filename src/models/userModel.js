const pool = require('../config/db');

async function createUser({ email, name, passwordHash }) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, name, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, email, name, created_at`,
    [email, name, passwordHash]
  );
  return rows[0];
}

async function findByEmail(email) {
  const { rows } = await pool.query(
    'SELECT id, email, name, password_hash FROM users WHERE email = $1',
    [email]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await pool.query(
    'SELECT id, email, name, created_at FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
}

module.exports = { createUser, findByEmail, findById };