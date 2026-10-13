module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
  globalSetup: '<rootDir>/tests/support/globalSetup.js',
  setupFiles: ['<rootDir>/tests/support/setupEnv.js'],
  testTimeout: 30000,
  // Silences application logs during tests. Run `npx jest --runInBand --silent=false` to see them.
  silent: true,
};
