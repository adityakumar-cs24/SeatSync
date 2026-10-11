require('dotenv').config();

const accessSecret = process.env.JWT_ACCESS_SECRET;

if (!accessSecret || accessSecret.length < 32) {
  throw new Error('JWT_ACCESS_SECRET must be set to a random string of at least 32 characters');
}

module.exports = {
  accessSecret,
  accessTtl: process.env.JWT_ACCESS_TTL || '15m',
  refreshTtlDays: parseInt(process.env.REFRESH_TTL_DAYS || '7', 10),
  bcryptCost: parseInt(process.env.BCRYPT_COST || '12', 10),
};