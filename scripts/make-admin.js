require('dotenv').config();
const pool = require('../src/config/db');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: npm run make-admin -- <email>');
    process.exit(1);
  }

  const { rowCount } = await pool.query("UPDATE users SET role = 'admin' WHERE email = $1", [email]);
  console.log(rowCount ? `${email} is now an admin` : `No user with email ${email}`);

  await pool.end();
  process.exit(rowCount ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});