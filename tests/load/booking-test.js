import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const VUS = parseInt(__ENV.VUS || '50', 10);
const MODE = __ENV.MODE || 'different_keys'; // 'different_keys' | 'same_key'
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const bookingCreated = new Counter('booking_created');       // 201
const bookingReplay = new Counter('booking_replay');         // 200 / 202
const bookingConflict = new Counter('booking_conflict');     // 409
const bookingUnexpected = new Counter('booking_unexpected'); // anything not allowed in this mode
const paymentCharges = new Counter('payment_charges');       // gateway calls during the test

http.setResponseCallback(http.expectedStatuses(200, 201, 202, 409));

const thresholds = {
  booking_created: ['count==1'],
  booking_unexpected: ['count==0'],
  payment_charges: ['count==1'], // the gateway must be charged exactly once
};
if (MODE === 'different_keys') {
  thresholds.booking_conflict = [`count==${VUS - 1}`];
} else {
  thresholds.booking_replay = [`count==${VUS - 1}`];
}

export const options = {
  scenarios: {
    concurrent_bookings: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds,
};

export function setup() {
  if (MODE !== 'different_keys' && MODE !== 'same_key') {
    throw new Error("MODE must be 'different_keys' or 'same_key'");
  }

  // Each run builds its own fresh event, seat and lock.
  const eventRes = http.post(
    `${BASE_URL}/api/events`,
    JSON.stringify({
      name: `BookingLoad-${MODE}-${Date.now()}`,
      eventTime: '2030-01-01T19:00:00Z',
      totalSeats: 1,
    }),
    { headers: JSON_HEADERS }
  );
  if (eventRes.status !== 201) throw new Error(`event creation failed: ${eventRes.status}`);
  const seatId = eventRes.json('seats.0.id');

  const userId = fakeUuid();
  const lockRes = http.post(
    `${BASE_URL}/api/seats/${seatId}/lock`,
    JSON.stringify({ userId }),
    { headers: JSON_HEADERS }
  );
  if (lockRes.status !== 200) throw new Error(`seat lock failed: ${lockRes.status}`);

  const statsRes = http.get(`${BASE_URL}/api/test/payment-stats`);
  if (statsRes.status !== 200) {
    throw new Error('payment-stats endpoint unavailable (is NODE_ENV=production?)');
  }

  return {
    seatId,
    userId,
    chargesBefore: statsRes.json('charges'),
    runId: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  };
}

export default function (data) {
  const key =
    MODE === 'same_key' ? `load-${data.runId}-shared` : `load-${data.runId}-vu${__VU}`;

  const res = http.post(
    `${BASE_URL}/api/bookings`,
    JSON.stringify({ seatId: data.seatId, userId: data.userId }),
    { headers: { ...JSON_HEADERS, 'Idempotency-Key': key } }
  );

  const status = res.status;
  if (status === 201) {
    bookingCreated.add(1);
  } else if (MODE === 'different_keys' && status === 409) {
    bookingConflict.add(1);
  } else if (MODE === 'same_key' && (status === 200 || status === 202)) {
    bookingReplay.add(1);
  } else {
    bookingUnexpected.add(1);
  }
}

export function teardown(data) {
  const statsRes = http.get(`${BASE_URL}/api/test/payment-stats`);
  paymentCharges.add(statsRes.json('charges') - data.chargesBefore);
  console.log(`seatId=${data.seatId} mode=${MODE} vus=${VUS}`);
}

function fakeUuid() {
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}