import http from 'k6/http';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// Event creation is admin-only, so load tests log in as an admin account that is prepared once
// (see README). Credentials come from the environment and are never stored in the repository.
// Returns the id of the first seat of the new event.
export function createEvent(name, totalSeats) {
  const email = __ENV.ADMIN_EMAIL;
  const password = __ENV.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set (see the load testing section of the README)');
  }

  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email, password }),
    { headers: JSON_HEADERS }
  );
  if (loginRes.status !== 200) throw new Error(`admin login failed: ${loginRes.status}`);
  const adminToken = loginRes.json('accessToken');

  const eventRes = http.post(
    `${BASE_URL}/api/events`,
    JSON.stringify({ name, eventTime: '2030-01-01T19:00:00Z', totalSeats }),
    { headers: { ...JSON_HEADERS, Authorization: `Bearer ${adminToken}` } }
  );
  if (eventRes.status === 403) {
    throw new Error(`${email} is not an admin. Run: npm run make-admin -- ${email}`);
  }
  if (eventRes.status !== 201) throw new Error(`event creation failed: ${eventRes.status}`);

  return eventRes.json('seats.0.id');
}