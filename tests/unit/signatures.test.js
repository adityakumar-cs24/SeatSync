const crypto = require('crypto');
const { verifyCheckoutSignature, verifyWebhookSignature } = require('../../src/services/payment/signatures');

const hmac = (secret, message) => crypto.createHmac('sha256', secret).update(message).digest('hex');

describe('checkout signature (order_id|payment_id)', () => {
  const secret = 'key-secret-for-tests';
  const args = { orderId: 'order_ABC123', paymentId: 'pay_XYZ789' };
  const good = hmac(secret, 'order_ABC123|pay_XYZ789');

  test('accepts the correct signature', () => {
    expect(verifyCheckoutSignature({ ...args, signature: good }, secret)).toBe(true);
  });

  test('rejects a signature that belongs to another payment or order', () => {
    expect(verifyCheckoutSignature({ ...args, paymentId: 'pay_OTHER', signature: good }, secret)).toBe(false);
    expect(verifyCheckoutSignature({ ...args, orderId: 'order_OTHER', signature: good }, secret)).toBe(false);
  });

  test('rejects a signature made with a different secret', () => {
    expect(verifyCheckoutSignature({ ...args, signature: hmac('another-secret', 'order_ABC123|pay_XYZ789') }, secret)).toBe(false);
  });

  test.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 123],
    ['too long', `${good}00`],
  ])('rejects a %s signature without throwing', (_label, signature) => {
    expect(verifyCheckoutSignature({ ...args, signature }, secret)).toBe(false);
  });

  test('rejects when an input is missing', () => {
    expect(verifyCheckoutSignature({ orderId: 'order_ABC123', signature: good }, secret)).toBe(false);
    expect(verifyCheckoutSignature({ ...args, signature: good }, '')).toBe(false);
  });
});

describe('webhook signature (raw body)', () => {
  const secret = 'webhook-secret-for-tests';
  const raw = Buffer.from('{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_1"}}}}');
  const good = hmac(secret, raw);

  test('accepts the exact raw bytes, as Buffer or string', () => {
    expect(verifyWebhookSignature(raw, good, secret)).toBe(true);
    expect(verifyWebhookSignature(raw.toString('utf8'), good, secret)).toBe(true);
  });

  test('rejects a body that was parsed and re-serialised (whitespace differs)', () => {
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8')), null, 2));
    expect(verifyWebhookSignature(reserialised, good, secret)).toBe(false);
  });

  test('rejects a tampered body and a wrong secret', () => {
    expect(verifyWebhookSignature(Buffer.from(raw.toString('utf8').replace('pay_1', 'pay_2')), good, secret)).toBe(false);
    expect(verifyWebhookSignature(raw, hmac('other-secret', raw), secret)).toBe(false);
  });

  test('rejects a missing signature and a non-body input', () => {
    expect(verifyWebhookSignature(raw, undefined, secret)).toBe(false);
    expect(verifyWebhookSignature({ event: 'payment.captured' }, good, secret)).toBe(false);
  });

  test('throws when no webhook secret is configured, instead of silently accepting', () => {
    expect(() => verifyWebhookSignature(raw, good, null)).toThrow(/not configured/);
  });
});
