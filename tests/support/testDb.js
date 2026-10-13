require('dotenv').config({ quiet: true });

// The test database is derived from DATABASE_URL (same server, different database name),
// unless TEST_DATABASE_URL is set explicitly.
function testDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('DATABASE_URL or TEST_DATABASE_URL must be set');

  const url = new URL(base);
  url.pathname = '/booking_test';
  return url.toString();
}

module.exports = { testDatabaseUrl };
