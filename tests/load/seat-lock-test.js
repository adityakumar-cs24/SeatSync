import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const VUS = parseInt(__ENV.VUS || '100', 10);
const PASSWORD = 'load-test-pass-1';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

const lockSuccess = new Counter('seat_lock_success');
const lockConflict = new Counter('seat_lock_conflict');
const lockUnexpected = new Counter('seat_lock_unexpected');

http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export const options = {
  scenarios: {
    concurrent_lock_attempts: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1,
      maxDuration: '60s',
    },
  },
  thresholds: {
    seat_lock_success: ['count==1'],
    seat_lock_conflict: [`count==${VUS - 1}`],
    seat_lock_unexpected: ['count==0'],
  },
};

// Creates one real, authenticated user per virtual user, plus a fresh single-seat event.
// Done in setup() so the timed section measures only the lock race.
export function setup() {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  const eventRes = http.post(
    `${BASE_URL}/api/events`,
    JSON.stringify({ name: `LockLoad-${runId}`, eventTime: '2030-01-01T19:00:00Z', totalSeats: 1 }),
    { headers: JSON_HEADERS }
  );
  if (eventRes.status !== 201) throw new Error(`event creation failed: ${eventRes.status}`);
  const seatId = eventRes.json('seats.0.id');

  const emails = Array.from({ length: VUS }, (_, i) => `lock-${runId}-${i}@loadtest.example.com`);

  const registerReqs = emails.map((email) => [
    'POST',
    `${BASE_URL}/api/auth/register`,
    JSON.stringify({ email, name: 'Load User', password: PASSWORD }),
    { headers: JSON_HEADERS },
  ]);
  http.batch(registerReqs).forEach((res, i) => {
    if (res.status !== 201) throw new Error(`register ${i} failed: ${res.status}`);
  });

  const loginReqs = emails.map((email) => [
    'POST',
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: JSON_HEADERS },
  ]);
  const tokens = http.batch(loginReqs).map((res, i) => {
    if (res.status !== 200) throw new Error(`login ${i} failed: ${res.status}`);
    return res.json('accessToken');
  });

  return { seatId, tokens };
}

export default function (data) {
  const token = data.tokens[__VU - 1];

  const res = http.post(`${BASE_URL}/api/seats/${data.seatId}/lock`, null, {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });

  if (res.status === 200) lockSuccess.add(1);
  else if (res.status === 409) lockConflict.add(1);
  else lockUnexpected.add(1);
}

export function teardown(data) {
  console.log(`seatId=${data.seatId} vus=${VUS}`);
}