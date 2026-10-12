# SeatSync

A high-concurrency event booking backend inspired by BookMyShow and IRCTC. It is built around one hard problem: when hundreds of users try to reserve the same seat at the same instant, exactly one of them must win.

## Status: 🚧 In Progress

## Roadmap
- [x] Project setup, Express server, health check
- [x] Dockerized PostgreSQL + Redis
- [x] Database migrations (events, seats, bookings)
- [x] Atomic seat locking with TTL-based expiry
- [x] Load testing with k6 (100 and 500 concurrent users)
- [x] Booking confirmation with idempotency keys
- [x] Authentication: register, login, access and refresh tokens, protected seat and booking routes
- [ ] Roles (admin-only event creation)
- [ ] Payment webhooks
- [ ] Redis lock layer
- [x] Background jobs (BullMQ reconciler)
- [ ] Real-time seat updates (Socket.io)

## Tech Stack
**Used so far:** Node.js, Express 5, PostgreSQL 16 (raw `pg`, no ORM), `node-pg-migrate`, Docker Compose, Redis + BullMQ, JWT + bcrypt, k6

**Planned:** Socket.io, Stripe (test mode)

## API

| Method | Endpoint | Description | Responses |
|---|---|---|---|
| GET | `/health` | Health check | 200 |
| POST | `/api/events` | Create an event with N seats (A1..AN) | 201, 400 |
| GET | `/api/events/:eventId/seats` | List seats of an event | 200, 400, 404 |
| POST | `/api/seats/:seatId/lock` | Lock a seat for 8 minutes (requires auth) | 200, 400, 404, 409 |
| POST | `/api/seats/:seatId/release` | Release a seat you hold (requires auth) | 200, 400, 404 |
| POST | `/api/bookings` | Confirm a locked seat. Needs `Idempotency-Key` header and `{ "seatId" }`, requires auth | 201, 200 (replay), 202, 400, 402, 404, 409, 422 |
| GET | `/api/bookings/:bookingId` | Fetch a booking | 200, 400, 404 |
| POST | `/api/auth/register` | Create an account (`{ "email", "name", "password" }`) | 201, 400, 409 |
| POST | `/api/auth/login` | Log in, returns an access token | 200, 400, 401 |
| POST | `/api/auth/refresh` | Exchange a refresh token for a new access and refresh token | 200, 400, 401 |
| POST | `/api/auth/logout` | Revoke the session (`{ "refreshToken" }`) | 204, 400 |
| GET | `/api/auth/me` | Current user (needs `Authorization: Bearer <token>`) | 200, 401 |

## How double-booking is prevented

**1. Atomic conditional update.** Locking is a single SQL statement:

```sql
UPDATE seats
SET status = 'LOCKED', locked_by = $1, locked_until = NOW() + INTERVAL '8 minutes'
WHERE id = $2
  AND (status = 'AVAILABLE' OR (status = 'LOCKED' AND locked_until < NOW()))
RETURNING id, status, locked_by, locked_until;
```

PostgreSQL takes a row-level lock while this runs, so concurrent updates on the same row are serialized. After the first one commits, the `WHERE` clause no longer matches for the others: they update 0 rows and receive `409 Conflict`. There is no separate `SELECT` followed by `UPDATE`, so there is no race window.

**2. Lazy expiry.** An abandoned lock (user never paid) becomes claimable again once `locked_until` passes. This is evaluated inside the same atomic statement, so no cron job is needed and expiry itself is race-free.

**3. Guarded release.** Only the lock holder can release, and only while the seat is still `LOCKED`. A `BOOKED` seat can never be released.

**4. Schema-level safety net.** A partial unique index allows at most one confirmed booking per seat, even if application code has a bug:

```sql
CREATE UNIQUE INDEX idx_one_confirmed_booking_per_seat
ON bookings (seat_id) WHERE status = 'CONFIRMED';
```

`bookings.idempotency_key` is also unique, so a retried request cannot create a second booking (the booking flow itself is the next milestone).

## Authentication

Users register with email and password and receive a short-lived JWT access token (15 minutes, HS256).

- **Passwords** are hashed with bcrypt (cost 12). Passwords over 72 bytes are rejected because bcrypt silently ignores everything beyond that.
- **Login errors are uniform.** An unknown email and a wrong password return the same `401` message, and an unknown email is still compared against a dummy hash so response time does not reveal which emails exist.
- **Duplicate emails are decided by the database.** A unique constraint resolves concurrent signups; there is no check-then-insert race.
- **The JWT algorithm is pinned** to HS256 when verifying, so unsigned (`alg: none`) and algorithm-confusion tokens are rejected.
- **Expired and invalid tokens** return distinct codes (`TOKEN_EXPIRED`, `TOKEN_INVALID`) so a client knows when to refresh.
- The server refuses to start if `JWT_ACCESS_SECRET` is missing or shorter than 32 characters.

- **Refresh tokens** are random opaque strings (not JWTs). Only their SHA-256 hash is stored, so a database leak does not expose usable tokens.
- **Rotation:** every refresh revokes the presented token and issues a new one in the same transaction.
- **Reuse detection:** presenting an already-used token means two parties hold it (theft or a replayed request), so the whole session (token family) is revoked.
- **Refresh races are atomic.** Revocation is a single `UPDATE ... WHERE revoked_at IS NULL`, the same pattern as seat locking. Ten parallel refreshes with one token produce exactly one success.
- **Logout** revokes the whole session and always returns `204`, so it cannot be used to probe for valid tokens.

Known limitations: an access token stays valid for up to 15 minutes after logout (it is stateless; the short expiry is the trade-off). Two browser tabs refreshing the same token at once will both be logged out; production systems usually allow a short grace window. Expired refresh tokens are not purged yet, and login and refresh are not rate limited.

**Authorization:**
- Seat and booking routes require a Bearer token. The acting user always comes from the verified token; a `userId` in the request body is ignored, so identity cannot be spoofed.
- `GET /api/bookings/:id` returns `404` (not `403`) for someone else's booking, so booking ids cannot be probed.
- `POST /api/events` is still unauthenticated; admin roles are planned.

## Booking and idempotency

`POST /api/bookings` converts a locked seat into a confirmed booking. The `Idempotency-Key` header is required: the client generates one key per purchase intent and reuses it on every retry.

Payment is mocked behind a `charge()` / `refund()` interface, so a real gateway adapter (e.g. Stripe) can replace it without touching the booking logic. The `simulate: "fail"` request field is a test hook that is disabled when `NODE_ENV=production`.

**Flow (3 phases, payment outside any DB transaction):**
1. Short transaction: `SELECT ... FOR UPDATE` on the seat, verify the caller holds an active lock, insert a `PENDING` booking.
2. Charge the payment gateway. Only the request that inserted the `PENDING` row ever reaches this step.
3. Short transaction: mark the seat `BOOKED` and the booking `CONFIRMED`. If payment failed, mark the booking `FAILED` and keep the seat locked so the user can retry with a new key.

The payment call is deliberately outside the transactions: a slow gateway must not hold a row lock or a pooled DB connection.

**Verified behaviour:**

| Scenario | Result |
|---|---|
| Same key retried after success | 200, same booking returned, no second charge |
| Same key while the first request is still processing | 202 |
| 20 parallel requests with the same key | exactly one 201, nineteen 202 |
| 10 parallel double-clicks with different keys | exactly one 201, nine 409 |
| Payment declined, same key retried | 402, same failed booking returned |
| Payment declined, retry with a new key | 201 |
| Same key reused for a different user or seat | 422 |
| Insert a second `CONFIRMED` booking for a booked seat directly in SQL | rejected by `idx_one_confirmed_booking_per_seat` |

**Known limitations (planned):**
- A crash between phase 1 and phase 3 leaves a `PENDING` booking that blocks the seat until the background reconciler fails it (see below).
- A real gateway timeout leaves the payment outcome unknown. That case should stay `PENDING` and be resolved by a payment webhook.
- No authentication yet: `userId` comes from the request body.

## Background reconciler

A separate worker process (`npm run worker`) runs a BullMQ job every 30 seconds (`RECONCILER_INTERVAL_MS`). It does two things:

1. **Fails stale `PENDING` bookings** (older than `STALE_PENDING_SECONDS`, default 300). A server crash between booking phase 1 and phase 3 would otherwise leave an orphaned row that blocks the seat forever.
2. **Releases expired locks**, so the stored seat status matches reality. Seats with a `PENDING` booking are skipped: a payment may still be in flight.

Correctness does not depend on this job. Expired locks are already claimable through the atomic lock query; the reconciler cleans up state and unblocks orphaned bookings.

Why BullMQ instead of `setInterval`: with several worker instances, a repeatable job is executed by one worker at a time, and the schedule is upserted so restarts never duplicate it.

Verified by simulating a crash (orphaned `PENDING` booking, 10 minutes old) alongside three other states:

| Seat state before | After reconciler |
|---|---|
| Expired lock, no booking | `AVAILABLE` |
| Valid lock + stale `PENDING` booking | booking `FAILED (STALE_PENDING_TIMEOUT)`, seat bookable again |
| Expired lock + fresh `PENDING` booking (payment in flight) | untouched |
| Valid lock, nothing else | untouched |

**Known limitations:**
- With a real gateway, failing a stale `PENDING` booking outright is unsafe because the payment may have succeeded. The reconciler would first query the gateway by idempotency key.
- The stale threshold must stay longer than the gateway timeout, otherwise a slow but legitimate payment can be failed.

## Concurrency testing

k6 fires N virtual users at the **same seat** at the same instant. The test is configured to **fail** unless exactly one request succeeds and every other request gets `409`.

| Concurrent users | Locks won (200) | Rejected (409) | Unexpected (400/404/500) | HTTP failures |
|---|---|---|---|---|
| 100 | 1 | 99 | 0 | 0% |
| 500 | 1 | 499 | 0 | 0% |

Results are cross-checked against the database: one row, `LOCKED`, a single `locked_by`.

Re-running against a seat whose earlier lock had expired also produced exactly one winner, which shows the lazy-expiry path is atomic as well.

Run it yourself (use a fresh seat every time; a seat that is still locked will correctly make the test fail):

```bash
SEAT_ID=$(curl -s -X POST localhost:5000/api/events -H "Content-Type: application/json" \
  -d '{"name":"LoadTest","eventTime":"2026-12-01T19:00:00Z","totalSeats":1}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).seats[0].id')

k6 run -e SEAT_ID=$SEAT_ID tests/load/seat-lock-test.js                 # 100 users
k6 run -e SEAT_ID=$SEAT_ID -e VUS=500 tests/load/seat-lock-test.js      # 500 users
```

Note: this measures worst-case contention on a single row. Real traffic is spread across many seats, which is lower contention per row.

### Booking concurrency

`tests/load/booking-test.js` builds its own event, seat and lock, then fires N parallel booking requests. It fails unless exactly one booking is created **and the payment gateway is charged exactly once** (counted by the mock gateway, exposed through a dev-only endpoint that is not mounted in production).

| Scenario | Requests | 201 | 409 | 200/202 (replay) | Unexpected | Gateway charges | DB rows |
|---|---|---|---|---|---|---|---|
| Different idempotency keys (double-click race) | 50 | 1 | 49 | 0 | 0 | 1 | 1 `CONFIRMED` |
| Same idempotency key (retry storm) | 50 | 1 | 0 | 49 | 0 | 1 | 1 `CONFIRMED` |

```bash
k6 run -e MODE=different_keys -e VUS=50 tests/load/booking-test.js
k6 run -e MODE=same_key -e VUS=50 tests/load/booking-test.js
```

The charge counter is in-memory and per process, so it is only valid for a single server instance.

## Design decisions

- **Raw SQL with `pg`, no ORM.** The core guarantee depends on one precise atomic statement, so I wanted full control over the exact SQL.
- **Migrations, never manual DDL.** Schema changes are versioned and reversible. A bug found later (timestamps) was fixed with a new migration instead of editing an applied one.
- **`timestamptz` everywhere.** Timezone-naive columns shifted values by 5h30m when read from a non-UTC machine; fixed in migration `005`.
- **Event and seats are created in one transaction**, so a failure can never leave an event without seats.
- **Parameterized queries only**, which prevents SQL injection.
- **Input validated before touching the database** (UUID format, seat count bounds, date parsing) so bad input returns `400` rather than `500`.
- **Connection pooling** (max 20) so traffic bursts reuse connections instead of exhausting Postgres.

## Project structure

```
src/
  config/        env + database pool
  routes/        URL definitions only
  controllers/   HTTP layer: validation, status codes
  services/      business logic (seat locking)
  models/        SQL queries
  utils/         helpers (UUID validation)
migrations/      versioned schema changes
tests/load/      k6 concurrency test
```

## Running locally

### Prerequisites
- Node.js v18+
- Docker & Docker Compose
- [k6](https://k6.io/docs/get-started/installation/) (only for the load test)

### Setup
1. Clone and install dependencies:
```bash
   git clone https://github.com/adityakumar-cs24/SeatSync.git
   cd SeatSync
   npm install
```
2. Copy the env file:
```bash
   cp .env.example .env
```
3. Start PostgreSQL and Redis (Postgres is exposed on host port **5433**):
```bash
   docker-compose up -d
```
4. Run migrations:
```bash
   npm run migrate up
```
5. Start the dev server:
```bash
   npm run dev
```

   In a second terminal, start the background worker:
   ```bash
   npm run worker
   ```

The credentials in `docker-compose.yml` are for local development only. Real secrets must come from environment variables or a secrets manager.
