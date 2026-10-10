import http from 'k6/http';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const SEAT_ID = __ENV.SEAT_ID;
const VUS = parseInt(__ENV.VUS || '100', 10);

http.setResponseCallback(http.expectedStatuses(200, 409));
const lockSuccess = new Counter('seat_lock_success');
const lockConflict = new Counter('seat_lock_conflict');
const lockUnexpected = new Counter('seat_lock_unexpected');

export const options = {
  scenarios: {
    concurrent_lock_attempts: {
      executor: 'per-vu-iterations',
      vus: VUS,
      iterations: 1, // each virtual user attempts the lock exactly once
      maxDuration: '30s',
    },
  },
  // The test FAILS unless exactly one request wins and every other one gets 409.
  thresholds: {
    seat_lock_success: ['count==1'],
    seat_lock_conflict: [`count==${VUS - 1}`],
    seat_lock_unexpected: ['count==0'],
  },
};

export function setup() {
  if (!SEAT_ID) {
    throw new Error('SEAT_ID is required. Run: k6 run -e SEAT_ID=<seat-uuid> tests/load/seat-lock-test.js');
  }
}

export default function () {
  const res = http.post(
    `${BASE_URL}/api/seats/${SEAT_ID}/lock`,
    JSON.stringify({ userId: fakeUuid() }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (res.status === 200) lockSuccess.add(1);
  else if (res.status === 409) lockConflict.add(1);
  else lockUnexpected.add(1); // 400/404/500 etc. means something is wrong
}

function fakeUuid() {
  const hex = (n) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}