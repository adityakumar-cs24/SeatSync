require('dotenv').config();

const accessSecret = process.env.JWT_ACCESS_SECRET;

// Fail fast at startup instead of signing tokens with a missing or weak secret.
if (!accessSecret || accessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be set to a random string of at least 32 characters');
}

module.exports = {
  accessSecret,
  accessTtl: process.env.JWT_ACCESS_TTL || '15m',
  bcryptCost: parseInt(process.env.BCRYPT_COST || '12', 10),
};