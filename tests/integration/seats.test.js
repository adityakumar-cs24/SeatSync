const crypto = require('crypto');
const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/config/db');
const {
  createUser, createEvent, lockSeat, releaseSeat, seatRow, bearer, closeDb,
} = require('../support/helpers');

afterAll(closeDb);

describe('locking', () => {
  test('requires authentication', async () => {
    const { seats } = await createEvent(1);
    const res = await request(app).post(`/api/seats/${seats[0].id}/lock`);
    expect(res.status).toBe(401);
  });

  test('the first user wins and the second gets 409', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { seats } = await createEvent(1);

    const first = await lockSeat(alice.accessToken, seats[0].id);
    expect(first.status).toBe(200);
    expect(first.body.seat.locked_by).toBe(alice.id);

    const second = await lockSeat(bob.accessToken, seats[0].id);
    expect(second.status).toBe(409);
  });

  test('the lock lasts 8 minutes', async () => {
    const user = await createUser();
    const { seats } = await createEvent(1);
    const res = await lockSeat(user.accessToken, seats[0].id);

    const minutes = (new Date(res.body.seat.locked_until) - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(7.5);
    expect(minutes).toBeLessThanOrEqual(8);
  });

  test('an unknown seat gives 404 and a malformed id gives 400', async () => {
    const user = await createUser();
    expect((await lockSeat(user.accessToken, crypto.randomUUID())).status).toBe(404);
    expect((await lockSeat(user.accessToken, 'not-a-uuid')).status).toBe(400);
  });

  test('50 users race for one seat: exactly one wins', async () => {
    const users = await Promise.all(Array.from({ length: 50 }, () => createUser()));
    const { seats } = await createEvent(1);

    const results = await Promise.all(users.map((u) => lockSeat(u.accessToken, seats[0].id)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(49);

    const winner = users[codes.indexOf(200)];
    const row = await seatRow(seats[0].id);
    expect(row.status).toBe('LOCKED');
    expect(row.locked_by).toBe(winner.id);
  });

  test('an expired lock can be taken over, and the takeover is atomic too', async () => {
    const original = await createUser();
    const { seats } = await createEvent(1);
    await lockSeat(original.accessToken, seats[0].id);
    await pool.query("UPDATE seats SET locked_until = now() - interval '1 minute' WHERE id = $1", [seats[0].id]);

    const users = await Promise.all(Array.from({ length: 20 }, () => createUser()));
    const results = await Promise.all(users.map((u) => lockSeat(u.accessToken, seats[0].id)));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
  });
});

describe('releasing', () => {
  test('only the lock holder can release', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { seats } = await createEvent(1);
    await lockSeat(alice.accessToken, seats[0].id);

    expect((await releaseSeat(bob.accessToken, seats[0].id)).status).toBe(404);
    expect((await releaseSeat(alice.accessToken, seats[0].id)).status).toBe(200);
    expect((await seatRow(seats[0].id)).status).toBe('AVAILABLE');
  });

  test('a body userId cannot be used to release someone else\'s lock', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { seats } = await createEvent(1);
    await lockSeat(alice.accessToken, seats[0].id);

    const res = await request(app)
      .post(`/api/seats/${seats[0].id}/release`)
      .set(bearer(bob.accessToken))
      .send({ userId: alice.id });
    expect(res.status).toBe(404);
    expect((await seatRow(seats[0].id)).status).toBe('LOCKED');
  });

  test('a BOOKED seat can never be released', async () => {
    const user = await createUser();
    const { seats } = await createEvent(1);
    await lockSeat(user.accessToken, seats[0].id);
    await pool.query("UPDATE seats SET status = 'BOOKED' WHERE id = $1", [seats[0].id]);

    expect((await releaseSeat(user.accessToken, seats[0].id)).status).toBe(404);
    expect((await seatRow(seats[0].id)).status).toBe('BOOKED');
  });

  test('a released seat can be locked by someone else', async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { seats } = await createEvent(1);
    await lockSeat(alice.accessToken, seats[0].id);
    await releaseSeat(alice.accessToken, seats[0].id);

    expect((await lockSeat(bob.accessToken, seats[0].id)).status).toBe(200);
  });
});

describe('events', () => {
  test('creating an event is admin-only', async () => {
    const user = await createUser();
    const body = { name: 'X', eventTime: '2030-01-01T19:00:00Z', totalSeats: 2 };

    expect((await request(app).post('/api/events').send(body)).status).toBe(401);
    expect((await request(app).post('/api/events').set(bearer(user.accessToken)).send(body)).status).toBe(403);
  });

  test('seats are listed in natural order and the list is public', async () => {
    const { event } = await createEvent(12);
    const res = await request(app).get(`/api/events/${event.id}/seats`);
    expect(res.status).toBe(200);
    expect(res.body.seats.map((s) => s.seat_number)).toEqual(
      Array.from({ length: 12 }, (_, i) => `A${i + 1}`)
    );
  });

  test('listing seats validates the id and reports unknown events', async () => {
    expect((await request(app).get('/api/events/abc/seats')).status).toBe(400);
    expect((await request(app).get(`/api/events/${crypto.randomUUID()}/seats`)).status).toBe(404);
  });
});
