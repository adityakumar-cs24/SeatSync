# SeatSync

A high-concurrency event booking backend inspired by BookMyShow and IRCTC, built to handle concurrent seat reservations, distributed locking, payment idempotency, and real-time seat availability.

## Status: 🚧 In Progress

## Tech Stack
- Node.js + Express
- PostgreSQL
- Redis
- BullMQ
- Socket.io
- Docker

## Why this project?
Seat booking systems are a classic distributed systems problem: multiple users can compete for the same limited resource at the same time.

SeatSync explores how to safely handle these concurrent requests using distributed locks, atomic database operations, TTL-based seat reservations, idempotent payment processing, and background job processing.

The goal is to ensure that even under high concurrency, a seat can be successfully booked by only one user.

## Roadmap
- [x] Project setup, Express server, health check
- [x] Dockerized PostgreSQL + Redis
- [x] Database migrations (events, seats, bookings)
- [x] Atomic seat locking with TTL-based expiry
- [x] Load testing with k6
- [ ] Booking confirmation with idempotency keys
- [ ] Redis lock layer
- [ ] Payment webhooks
- [ ] Background jobs (BullMQ)
- [ ] Real-time seat updates (Socket.io)

## Running Locally

### Prerequisites
- Node.js v18+
- Docker & Docker Compose

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
3. Start PostgreSQL and Redis:
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

## Concurrency Testing

100 virtual users (k6) attempt to lock the **same seat** at the same instant.
The test fails unless exactly one request succeeds.

| Metric | Result |
|---|---|
| Successful locks (200) | 1 |
| Rejected (409 Conflict) | 99 |
| Unexpected responses (400/404/500) | 0 |
| Database state | 1 row, `LOCKED`, single `locked_by` |

Run it yourself:

```bash
SEAT_ID=$(curl -s -X POST localhost:5000/api/events -H "Content-Type: application/json" \
  -d '{"name":"LoadTest","eventTime":"2026-12-01T19:00:00Z","totalSeats":1}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).seats[0].id')

k6 run -e SEAT_ID=$SEAT_ID tests/load/seat-lock-test.js
```

Use a fresh seat for every run: a locked seat will correctly make the test fail.

### Why only one request wins
`UPDATE seats SET status='LOCKED' ... WHERE id=$1 AND (status='AVAILABLE' OR lock expired)`
is a single atomic statement. PostgreSQL takes a row-level lock while it runs, so concurrent
updates on the same row are serialized. Once the first one commits, the `WHERE` clause no
longer matches for the rest, so they affect 0 rows and receive `409`.
