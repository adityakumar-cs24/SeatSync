const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),              // max connections in pool
  idleTimeoutMillis: 30000,   // close idle connection after 30s
  connectionTimeoutMillis: 5000, // fail fast if can't get connection in 5s
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;