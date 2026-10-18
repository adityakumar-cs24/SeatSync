const BASE_URL = 'https://api.razorpay.com/v1';
const MIN_AMOUNT_PAISE = 100;
const MAX_RECEIPT_LENGTH = 40;

class GatewayError extends Error {
  constructor(message, { status, code, retryable = false, cause } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (cause) this.cause = cause;
  }
}

// A thin client over the Razorpay REST API. It never logs and never puts credentials in an error.
function createRazorpayClient({
  keyId,
  keySecret,
  baseUrl = BASE_URL,
  timeoutMs = 8000,
  fetchImpl = (...args) => globalThis.fetch(...args),
}) {
  const authorization = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;

  async function request(method, path, body) {
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: authorization, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network failure or timeout: the outcome is unknown, so it is worth retrying later.
      throw new GatewayError(`Razorpay request failed (${err.name})`, { retryable: true, cause: err });
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const apiError = payload && payload.error;
      throw new GatewayError(apiError?.description || `Razorpay responded with HTTP ${res.status}`, {
        status: res.status,
        code: apiError?.code,
        retryable: res.status >= 500 || res.status === 429,
      });
    }
    if (payload === null) {
      throw new GatewayError('Razorpay returned a response that is not JSON', { status: res.status });
    }
    return payload;
  }

  const assertId = (id, name) => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  };

  return {
    // amountPaise is an integer number of paise (100 paise = 1 rupee).
    // Not retried automatically: a retry after a timeout could create a second order.
    createOrder({ amountPaise, currency = 'INR', receipt, notes }) {
      if (!Number.isInteger(amountPaise) || amountPaise < MIN_AMOUNT_PAISE) {
        throw new TypeError(`amountPaise must be an integer of at least ${MIN_AMOUNT_PAISE}`);
      }
      if (typeof receipt !== 'string' || receipt.length === 0 || receipt.length > MAX_RECEIPT_LENGTH) {
        throw new TypeError(`receipt must be 1-${MAX_RECEIPT_LENGTH} characters`);
      }
      if (!/^[A-Z]{3}$/.test(currency)) throw new TypeError('currency must be a 3-letter code');
      return request('POST', '/orders', { amount: amountPaise, currency, receipt, notes });
    },

    fetchOrder(orderId) {
      assertId(orderId, 'orderId');
      return request('GET', `/orders/${encodeURIComponent(orderId)}`);
    },

    fetchOrderPayments(orderId) {
      assertId(orderId, 'orderId');
      return request('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
    },
  };
}

module.exports = { createRazorpayClient, GatewayError, MIN_AMOUNT_PAISE, MAX_RECEIPT_LENGTH };
