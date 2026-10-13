const { execSync } = require('child_process');
const { Client } = require('pg');
const { testDatabaseUrl } = require('./testDb');

// Runs once before the whole suite: recreate the test database and apply every migration.
module.exports = async () => {
  const testUrl = new URL(testDatabaseUrl());
  const dbName = testUrl.pathname.slice(1);

  // This script DROPS the database, so refuse anything that does not look like a test database.
  if (!/^[a-z0-9_]*test[a-z0-9_]*$/i.test(dbName)) {
    throw new Error(`Refusing to reset "${dbName}": the test database name must contain "test"`);
  }

  const adminUrl = new URL(testUrl.toString());
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end();
  }

  try {
    execSync('npx node-pg-migrate up', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: testUrl.toString() },
    });
  } catch (err) {
    process.stdout.write(String(err.stdout || ''));
    process.stderr.write(String(err.stderr || ''));
    throw new Error('Migrations failed on the test database');
  }
};
