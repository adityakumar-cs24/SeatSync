# SeatSync

[![CI](https://github.com/adityakumar-cs24/SeatSync/actions/workflows/ci.yml/badge.svg)](https://github.com/adityakumar-cs24/SeatSync/actions/workflows/ci.yml)

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
- [x] Roles (admin-only event creation)
- [ ] Payment webhooks
- [x] Rate limiting (Redis) and load shedding
- [x] Background jobs (BullMQ reconciler)
- [ ] Real-time seat updates (Socket.io)

## Tech Stack
**Used so far:** Node.js, Express 5, PostgreSQL 16 (raw `pg`, no ORM), `node-pg-migrate`, Docker Compose, Redis + BullMQ, JWT + bcrypt, Docker, GitHub Actions, k6

**Planned:** Socket.io, Stripe (test mode)

## API

| Method | Endpoint | Description | Responses |
|---|---|---|---|
| GET | `/health` | Health check | 200 |
| POST | `/api/events` | Create an event with N seats (A1..AN). **Admin only** | 201, 400, 401, 403 |
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

Known limitations: an access token stays valid for up to 15 minutes after logout (it is stateless; the short expiry is the trade-off). Two browser tabs refreshing the same token at once will both be logged out; production systems usually allow a short grace window. Expired refresh tokens are not purged yet.

**Authorization:**
- Seat and booking routes require a Bearer token. The acting user always comes from the verified token; a `userId` in the request body is ignored, so identity cannot be spoofed.
- `GET /api/bookings/:id` returns `404` (not `403`) for someone else's booking, so booking ids cannot be probed.
- **Roles:** `POST /api/events` is admin-only (`403` for normal users). The role is read from the database on every admin request, not from the token, so demoting an admin takes effect immediately instead of after the token expires. A `role` sent at registration is ignored, and admins can only be created with a CLI script (`npm run make-admin -- <email>`), so there is no API path to privilege escalation.
- **Foreign keys** tie `seats.locked_by` and `bookings.user_id` to `users`, so the database itself rejects a lock or booking for a user that does not exist. A validly signed token for a deleted user returns `401`, not `500`.

## Rate limiting and load shedding

Counters live in Redis, so the limits hold across several API instances. Each check is one atomic Lua script (`INCR`, set the expiry on the first hit, read the remaining time), so concurrent requests can never all read "limit minus one" and slip through. Ten parallel logins against a limit of five produce exactly five passes and five `429`s.

| Route | Key | Limit |
|---|---|---|
| `POST /api/auth/login` | IP and email | 5 per 15 min (plus 30 per 15 min per IP across all emails) |
| `POST /api/auth/register` | IP | 10 per hour |
| `POST /api/auth/refresh` | IP | 30 per 15 min |
| `POST /api/seats/:id/lock` | user | 30 per minute |

Rejected requests get `429` with `Retry-After` and `RateLimit-*` headers. Behind a reverse proxy set `TRUST_PROXY` to the number of hops, otherwise every client looks like the proxy; leave it unset when the API is exposed directly, otherwise clients could spoof their IP through `X-Forwarded-For`.

**Fails open:** if Redis is unreachable the request is served instead of rejected (a broken limiter must not take the whole API down). The cost is that limits are not enforced during a Redis outage.

**Pool saturation:** when requests are already queued for a database connection, `POST /api/bookings` answers `503` with `Retry-After` immediately instead of making the client wait for the 5 second connection timeout and fail with `500`. Clients are expected to retry; the tests and the load test do.

Limitations: the window is fixed, so a client can send up to twice the limit around a window boundary; a sliding window or token bucket would fix that. Load tests register hundreds of users from one IP, so start the server with `RATE_LIMIT_ENABLED=false` when running them. The pool guard sheds as soon as one request is queued (`POOL_GUARD_MAX_WAITING`, default 0), which is conservative.

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

Event creation is admin-only, so the load tests log in as an admin account. Prepare it once (local throwaway credentials; never reuse real ones, and never commit them):

```bash
export ADMIN_EMAIL=loadtest-admin@example.com
export ADMIN_PASSWORD=load-admin-pass-1
curl -X POST localhost:5000/api/auth/register -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"name\":\"Load Admin\",\"password\":\"$ADMIN_PASSWORD\"}"
npm run make-admin -- "$ADMIN_EMAIL"
```

Each run creates its own event, seat and real registered users, so nothing needs to be prepared by hand and runs do not interfere with each other. Start the server with a low bcrypt cost so registering hundreds of users stays quick (test only; never use this in production):

```bash
RATE_LIMIT_ENABLED=false BCRYPT_COST=4 npm run dev

k6 run -e VUS=100 tests/load/seat-lock-test.js   # 100 users
k6 run -e VUS=500 tests/load/seat-lock-test.js   # 500 users
```

Every virtual user is a different authenticated account, so this exercises the full path: JWT verification, then the atomic lock.

Note: this measures worst-case contention on a single row. Real traffic is spread across many seats, which is lower contention per row.

### Booking concurrency

`tests/load/booking-test.js` registers a user, has an admin account create a single-seat event, locks the seat, then fires N parallel booking requests. It fails unless exactly one booking is created **and the payment gateway is charged exactly once** (counted by the mock gateway, exposed through a dev-only endpoint that is not mounted in production).

| Scenario | Requests | 201 | 409 | 200/202 (replay) | Unexpected | Gateway charges | DB rows |
|---|---|---|---|---|---|---|---|
| Different idempotency keys (double-click race) | 50 | 1 | 49 | 0 | 0 | 1 | 1 `CONFIRMED` |
| Same idempotency key (retry storm) | 50 | 1 | 0 | 49 | 0 | 1 | 1 `CONFIRMED` |

```bash
k6 run -e MODE=different_keys -e VUS=50 tests/load/booking-test.js
k6 run -e MODE=same_key -e VUS=50 tests/load/booking-test.js
```

When the database pool is saturated the API sheds booking requests with `503`; the load test retries them like a real client (28 retries in a typical 50-user run), and the final outcome is still exactly one booking and one charge.

The charge counter is in-memory and per process, so it is only valid for a single server instance.

## Found by load testing

Fifty parallel retries with the same idempotency key once produced `500`s: 41 of 50 requests failed after about 5 seconds, although payment stayed correct (one booking, one charge). The cause was nested pool acquisition: `reserveForPayment` held a pooled client while its idempotency lookup called `pool.query`, which needs a second connection. When more requests are in flight than the pool has connections, every held client waits for a connection that can only be freed by another waiting request, until the 5 second `connectionTimeoutMillis` fires. The fix runs the lookup on the client already held.

The bug is timing dependent, so it is reproduced with a small pool. With `DB_POOL_MAX=3` and 20 parallel same-key requests, the fixed code passed 3 of 3 runs (max latency about 330 ms). With the fix reverted, 2 of 3 runs failed with 16 to 18 of 20 requests returning `500` after about 5 s (the stack traces show the connection timeout inside the nested lookup), and 1 run passed by timing luck.

```bash
DB_POOL_MAX=3 BCRYPT_COST=4 npm run dev
k6 run -e MODE=same_key -e VUS=20 tests/load/booking-test.js
# to see the failure, first run: git revert --no-commit 1bfd3bf
```

Pool exhaustion is also a consistency risk, not only an availability one: a request whose final database step cannot get a connection after the gateway has charged would leave a `PENDING` booking. Failing fast with `503` when the pool is saturated is planned.

## Running everything in Docker

```bash
cp .env.example .env
```

Replace `JWT_ACCESS_SECRET` in `.env` with a random value first, otherwise the API would run with a publicly known secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

```bash
docker-compose --profile app up --build -d
```

This starts PostgreSQL, Redis, a one-off `migrate` job, the API on port 5000 and the background worker. The API and worker wait for the migrations to finish before they start. Plain `docker-compose up -d` still starts only PostgreSQL and Redis, which is what local development and the tests need.

- One multi-stage image serves both the API and the worker. The `runtime` stage contains production dependencies only and runs as the unprivileged `node` user; the `migrate` stage keeps `node-pg-migrate`, a dev dependency.
- `.env` is excluded from the image (`.dockerignore`); configuration is passed as environment variables by Compose. `JWT_ACCESS_SECRET` must be set in `.env`.
- The containers run with `NODE_ENV=production`, so the test-only routes and the `simulate` payment hook are disabled. The payment gateway is still the mock one.
- Stop the stack with `docker-compose --profile app down` (volumes are kept).

Stop `npm run dev` before starting the API container, both use port 5000. The load tests need the dev server, because they read the mock gateway's charge counter through a test route.

## Running the tests

```bash
docker-compose up -d     # PostgreSQL and Redis must be running
npm test                 # integration tests (about 60 tests, a few seconds)
npm run test:pool        # connection pool regression test (runs with a pool of 2)
```

The tests run against a real PostgreSQL, because the guarantees being tested (row locks, partial unique indexes, foreign keys) live in the database and cannot be mocked. They use a separate `booking_test` database that is dropped and recreated with all migrations on every run, and the setup refuses to touch any database whose name does not contain `test`. Each test creates its own users and events, so tests do not depend on each other. Redis is only needed by the rate limiter tests.

The suite covers registration, login and token handling, seat locking, booking idempotency, the reconciler, and several concurrency scenarios (50 parallel requests for one seat or one idempotency key). Mutation checks: breaking the lock condition or reverting the pool fix makes the suite fail.

CI (GitHub Actions) runs the same commands against a PostgreSQL service container on every push.

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
