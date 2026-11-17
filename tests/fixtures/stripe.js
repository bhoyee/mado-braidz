import Stripe from 'stripe';
export const paymentConfig = {
  NODE_ENV: 'test',
  APP_URL: 'http://localhost:4780',
  SESSION_SECRET: 'payment-test-secret-at-least-thirty-two-characters',
  DATABASE_URL: 'mysql://unused:unused@localhost/mado',
  UPLOAD_DIR: 'tmp/payment-test-uploads',
  STRIPE_WEBHOOK_SECRET: 'whsec_local_test_only',
};
export function fakeStripe() {
  const sessions = new Map(),
    keys = new Map(),
    refundKeys = new Map();
  const calls = { create: [], refund: [], expire: [] };
  return {
    sessions,
    calls,
    failRefund: false,
    async createSession(params, key) {
      calls.create.push({ params, key });
      if (keys.has(key)) return keys.get(key);
      const session = {
        id: 'cs_test_' + (sessions.size + 1),
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/test_' + (sessions.size + 1),
        status: 'open',
        payment_status: 'unpaid',
        amount_total: params.line_items[0].price_data.unit_amount,
        currency: 'usd',
        expires_at: params.expires_at,
        cancel_url: params.cancel_url,
        metadata: params.metadata,
        payment_intent: 'pi_test_' + (sessions.size + 1),
      };
      sessions.set(session.id, session);
      keys.set(key, session);
      return session;
    },
    async retrieveSession(id) {
      return sessions.get(id);
    },
    async expireSession(id) {
      calls.expire.push(id);
      const session = sessions.get(id);
      if (session.status !== 'open') throw new Error('Not open');
      session.status = 'expired';
      return session;
    },
    constructEvent: (raw, signature) =>
      Stripe.webhooks.constructEvent(
        raw,
        signature,
        paymentConfig.STRIPE_WEBHOOK_SECRET,
      ),
    async refund(payload, key) {
      calls.refund.push({ payload, key });
      if (this.failRefund) {
        this.failRefund = false;
        throw new Error('Temporary Stripe failure');
      }
      if (refundKeys.has(key)) return refundKeys.get(key);
      const refund = {
        id: 're_test_' + (refundKeys.size + 1),
        status: 'succeeded',
        amount: payload.amountCents,
        cumulativeAmountRefunded: payload.amountCents,
      };
      refundKeys.set(key, refund);
      return refund;
    },
  };
}
export function paidEvent(session, id = 'evt_paid') {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: { ...session, status: 'complete', payment_status: 'paid' },
    },
  };
}
export function signature(body) {
  return Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: paymentConfig.STRIPE_WEBHOOK_SECRET,
  });
}
