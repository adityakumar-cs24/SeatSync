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
- [ ] Load testing with k6
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
