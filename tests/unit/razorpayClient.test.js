const { createRazorpayClient, GatewayError } = require('../../src/services/payment/razorpayClient');

const KEY_ID = 'rzp_test_unitkey';
const KEY_SECRET = 'super-secret-value';
const expectedAuth = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`;

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });

function clientWith(fetchImpl, extra = {}) {
  return createRazorpayClient({ keyId: KEY_ID, keySecret: KEY_SECRET, fetchImpl, ...extra });
}

describe('createOrder', () => {
  test('sends an authenticated POST with the amount in paise and returns the order', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ id: 'order_1', amount: 25000, status: 'created' }));
    const order = await clientWith(fetchImpl).createOrder({
      amountPaise: 25000,
      receipt: 'booking-123',
      notes: { seat: 'A1' },
    });

    expect(order).toMatchObject({ id: 'order_1', amount: 25000 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.razorpay.com/v1/orders');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(expectedAuth);
    expect(JSON.parse(init.body)).toEqual({
      amount: 25000,
      currency: 'INR',
      receipt: 'booking-123',
      notes: { seat: 'A1' },
    });
  });

  test.each([
    ['below the 100 paise minimum', { amountPaise: 99, receipt: 'r' }],
    ['not an integer', { amountPaise: 100.5, receipt: 'r' }],
    ['a string', { amountPaise: '100', receipt: 'r' }],
    ['an empty receipt', { amountPaise: 100, receipt: '' }],
    ['a receipt over 40 characters', { amountPaise: 100, receipt: 'x'.repeat(41) }],
    ['a bad currency', { amountPaise: 100, receipt: 'r', currency: 'inr' }],
  ])('rejects %s before any network call', (_label, args) => {
    const fetchImpl = jest.fn();
    expect(() => clientWith(fetchImpl).createOrder(args)).toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('accepts a receipt of exactly 40 characters (a UUID booking id fits)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ id: 'order_1' }));
    await clientWith(fetchImpl).createOrder({ amountPaise: 100, receipt: 'x'.repeat(40) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('error handling', () => {
  test('maps a 4xx API error to a non-retryable GatewayError', async () => {
    const fetchImpl = async () =>
      jsonResponse({ error: { code: 'BAD_REQUEST_ERROR', description: 'The amount must be at least INR 1.00' } }, 400);
    await expect(clientWith(fetchImpl).createOrder({ amountPaise: 100, receipt: 'r' })).rejects.toMatchObject({
      name: 'GatewayError',
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      retryable: false,
      message: 'The amount must be at least INR 1.00',
    });
  });

  test.each([500, 502, 429])('treats HTTP %i as retryable', async (status) => {
    const fetchImpl = async () => jsonResponse({}, status);
    await expect(clientWith(fetchImpl).fetchOrder('order_1')).rejects.toMatchObject({ status, retryable: true });
  });

  test('treats a network failure as retryable', async () => {
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(clientWith(fetchImpl).fetchOrder('order_1')).rejects.toMatchObject({ retryable: true });
  });

  test('times out instead of hanging', async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const started = Date.now();
    await expect(clientWith(fetchImpl, { timeoutMs: 30 }).fetchOrder('order_1')).rejects.toMatchObject({
      retryable: true,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('rejects a successful response that is not JSON', async () => {
    const fetchImpl = async () => new Response('<html>oops</html>', { status: 200 });
    await expect(clientWith(fetchImpl).fetchOrder('order_1')).rejects.toBeInstanceOf(GatewayError);
  });

  test('never leaks credentials into an error', async () => {
    const fetchImpl = async () => jsonResponse({ error: { description: 'Authentication failed' } }, 401);
    const err = await clientWith(fetchImpl).fetchOrder('order_1').catch((e) => e);
    const text = `${err.message} ${JSON.stringify(err)} ${err.stack}`;
    expect(text).not.toContain(KEY_SECRET);
    expect(text).not.toContain(Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'));
  });
});

describe('fetch helpers', () => {
  test('fetchOrderPayments calls the order payments endpoint', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ items: [] }));
    await clientWith(fetchImpl).fetchOrderPayments('order_9');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.razorpay.com/v1/orders/order_9/payments');
    expect(fetchImpl.mock.calls[0][1].method).toBe('GET');
  });

  test('rejects an empty order id before any network call', () => {
    const fetchImpl = jest.fn();
    expect(() => clientWith(fetchImpl).fetchOrder('')).toThrow(TypeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
