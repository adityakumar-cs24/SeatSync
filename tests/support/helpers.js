const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');

const PASSWORD = 'correct-horse-9';

const uniq = () => crypto.randomBytes(6).toString('hex');
const bearer = (token) => ({ Authorization: `Bearer ${token}` });

// Registers and logs in a brand new user. Pass { admin: true } to promote it directly in the database
// (there is deliberately no API for that).
async function createUser({ admin = false } = {}) {
  const email = `u-${uniq()}@test.example.com`;

  const reg = await request(app)
    .post('/api/auth/register')
    .send({ email, name: 'Test User', password: PASSWORD });
  if (reg.status !== 201) {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  }

  if (admin) {
    await pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [reg.body.user.id]);
  }

  const login = await request(app).post('/api/auth/login').send({ email, password: PASSWORD });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }

  return {
    id: reg.body.user.id,
    email,
    password: PASSWORD,
    accessToken: login.body.accessToken,
    refreshToken: login.body.refreshToken,
  };
}

let adminPromise;
function getAdmin() {
  adminPromise ??= createUser({ admin: true });
  return adminPromise;
}

async function createEvent(totalSeats = 3) {
  const admin = await getAdmin();
  const res = await request(app)
    .post('/api/events')
    .set(bearer(admin.accessToken))
    .send({ name: `Event ${uniq()}`, eventTime: '2030-01-01T19:00:00Z', totalSeats });
  if (res.status !== 201) {
    throw new Error(`event creation failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { event: res.body.event, seats: res.body.seats };
}

const lockSeat = (token, seatId) =>
  request(app).post(`/api/seats/${seatId}/lock`).set(bearer(token));

const releaseSeat = (token, seatId) =>
  request(app).post(`/api/seats/${seatId}/release`).set(bearer(token));

const bookSeat = (token, seatId, idempotencyKey, extra = {}) =>
  request(app)
    .post('/api/bookings')
    .set(bearer(token))
    .set('Idempotency-Key', idempotencyKey)
    .send({ seatId, ...extra });

// The booking route sheds load with 503 + Retry-After while the DB pool is saturated, so a
// well-behaved client retries. This helper behaves like one.
async function bookSeatRetry(token, seatId, idempotencyKey, extra = {}, attempts = 20) {
  let res;
  for (let i = 0; i < attempts; i++) {
    res = await bookSeat(token, seatId, idempotencyKey, extra);
    if (res.status !== 503) return res;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return res;
}

async function seatRow(seatId) {
  const { rows } = await pool.query(
    'SELECT status, locked_by, locked_until FROM seats WHERE id = $1',
    [seatId]
  );
  return rows[0];
}

async function closeDb() {
  await pool.end();
}

module.exports = {
  PASSWORD,
  uniq,
  bearer,
  createUser,
  createEvent,
  lockSeat,
  releaseSeat,
  bookSeat,
  bookSeatRetry,
  seatRow,
  closeDb,
};
