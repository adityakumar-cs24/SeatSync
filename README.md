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

## Core Features
- High-concurrency seat reservation
- Distributed locking with Redis
- Temporary seat locks with TTL
- Atomic PostgreSQL transactions
- Idempotent payment handling
- Background jobs with BullMQ
- Real-time seat availability using Socket.io
- Dockerized development environment
