const { testDatabaseUrl } = require('./testDb');

// Runs before every test file, before any application module is loaded.
// dotenv never overrides variables that are already set, so these win over .env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = testDatabaseUrl();
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123456';
process.env.JWT_ACCESS_TTL = '15m';
process.env.BCRYPT_COST = '4';
