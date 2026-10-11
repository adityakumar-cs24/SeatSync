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
- [ ] Payment webhooks
- [ ] Redis lock layer
- [ ] Background jobs (BullMQ)
- [ ] Real-time seat updates (Socket.io)

## Tech Stack
**Used so far:** Node.js, Express 5, PostgreSQL 16 (raw `pg`, no ORM), `node-pg-migrate`, Docker Compose, k6

**Planned:** Redis (container already provisioned), BullMQ, Socket.io, Stripe (test mode)

## API

| Method | Endpoint | Description | Responses |
|---|---|---|---|
| GET | `/health` | Health check | 200 |
| POST | `/api/events` | Create an event with N seats (A1..AN) | 201, 400 |
| GET | `/api/events/:eventId/seats` | List seats of an event | 200, 400, 404 |
| POST | `/api/seats/:seatId/lock` | Lock a seat for 8 minutes (`{ "userId": "<uuid>" }`) | 200, 400, 404, 409 |
| POST | `/api/seats/:seatId/release` | Release a seat you hold (`{ "userId": "<uuid>" }`) | 200, 400, 404 |
| POST | `/api/bookings` | Confirm a locked seat. Needs `Idempotency-Key` header and `{ "seatId", "userId" }` | 201, 200 (replay), 202, 400, 402, 404, 409, 422 |
| GET | `/api/bookings/:bookingId` | Fetch a booking | 200, 400, 404 |

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
- A crash between phase 1 and phase 3 leaves a `PENDING` booking that blocks the seat. A background reconciler (BullMQ) will resolve stale `PENDING` bookings.
- A real gateway timeout leaves the payment outcome unknown. That case should stay `PENDING` and be resolved by a payment webhook.
- No authentication yet: `userId` comes from the request body.

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

The credentials in `docker-compose.yml` are for local development only. Real secrets must come from environment variables or a secrets manager.
