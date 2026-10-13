const pool = require('../../src/config/db');
const { runReconciliation } = require('../../src/services/reconcilerService');
const { createUser, createEvent, lockSeat, uniq, closeDb } = require('../support/helpers');

afterAll(closeDb);

// Builds one seat in a given state. The reconciler runs against the whole database, so every
// assertion below looks only at the seats created here.
async function seatInState({ lockExpired = false, pending = null }) {
  const user = await createUser();
  const { seats } = await createEvent(1);
  const seatId = seats[0].id;
  await lockSeat(user.accessToken, seatId);

  if (lockExpired) {
    await pool.query("UPDATE seats SET locked_until = now() - interval '1 minute' WHERE id = $1", [seatId]);
  }
  if (pending) {
    await pool.query(
      `INSERT INTO bookings (seat_id, user_id, status, idempotency_key, created_at)
       VALUES ($1, $2, 'PENDING', $3, now() - make_interval(mins => $4))`,
      [seatId, user.id, `rec-${uniq()}`, pending.ageMinutes]
    );
  }
  return seatId;
}

const seatStatus = async (id) =>
  (await pool.query('SELECT status FROM seats WHERE id = $1', [id])).rows[0].status;

const bookingStatus = async (seatId) =>
  (await pool.query('SELECT status, failure_reason FROM bookings WHERE seat_id = $1', [seatId])).rows[0];

test('an expired lock with no booking is released', async () => {
  const seatId = await seatInState({ lockExpired: true });
  await runReconciliation();
  expect(await seatStatus(seatId)).toBe('AVAILABLE');
});

test('a stale PENDING booking is failed, which unblocks the seat for a new attempt', async () => {
  const seatId = await seatInState({ pending: { ageMinutes: 10 } });
  await runReconciliation();

  expect(await bookingStatus(seatId)).toEqual({ status: 'FAILED', failure_reason: 'STALE_PENDING_TIMEOUT' });
  expect(await seatStatus(seatId)).toBe('LOCKED');
});

test('an expired lock with a fresh PENDING booking (payment in flight) is left alone', async () => {
  const seatId = await seatInState({ lockExpired: true, pending: { ageMinutes: 0 } });
  await runReconciliation();

  expect(await seatStatus(seatId)).toBe('LOCKED');
  expect((await bookingStatus(seatId)).status).toBe('PENDING');
});

test('a valid lock with nothing else is left alone', async () => {
  const seatId = await seatInState({});
  await runReconciliation();
  expect(await seatStatus(seatId)).toBe('LOCKED');
});

test('a BOOKED seat is never touched', async () => {
  const seatId = await seatInState({});
  await pool.query("UPDATE seats SET status = 'BOOKED', locked_until = now() - interval '1 hour' WHERE id = $1", [seatId]);
  await runReconciliation();
  expect(await seatStatus(seatId)).toBe('BOOKED');
});
