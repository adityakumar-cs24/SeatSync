const { loadPaymentConfig } = require('../../src/config/payment');

describe('payment configuration', () => {
  test('names the missing variables without printing any value', () => {
    expect(() => loadPaymentConfig({})).toThrow(/RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET/);
    expect(() => loadPaymentConfig({ RAZORPAY_KEY_ID: 'rzp_test_a' })).toThrow(/RAZORPAY_KEY_SECRET/);
  });

  test('accepts test keys and applies defaults', () => {
    const config = loadPaymentConfig({ RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's' });
    expect(config).toMatchObject({ keyId: 'rzp_test_a', webhookSecret: null, paymentWindowMinutes: 10 });
    expect(Object.isFrozen(config)).toBe(true);
  });

  test('refuses a live key unless live payments are explicitly allowed', () => {
    const env = { RAZORPAY_KEY_ID: 'rzp_live_a', RAZORPAY_KEY_SECRET: 's' };
    expect(() => loadPaymentConfig(env)).toThrow(/not a test key/);
    expect(loadPaymentConfig({ ...env, ALLOW_LIVE_PAYMENTS: 'true' }).keyId).toBe('rzp_live_a');
  });

  test('validates the payment window', () => {
    const env = { RAZORPAY_KEY_ID: 'rzp_test_a', RAZORPAY_KEY_SECRET: 's' };
    expect(() => loadPaymentConfig({ ...env, PAYMENT_WINDOW_MINUTES: '0' })).toThrow(/PAYMENT_WINDOW_MINUTES/);
    expect(loadPaymentConfig({ ...env, PAYMENT_WINDOW_MINUTES: '15' }).paymentWindowMinutes).toBe(15);
  });
});
