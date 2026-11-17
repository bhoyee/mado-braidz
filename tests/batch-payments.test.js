import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { createBookingService } from '../src/services/bookingService.js';
import { createPaymentService } from '../src/services/paymentService.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import {
  fakeStripe,
  paidEvent,
  paymentConfig,
  signature,
} from './fixtures/stripe.js';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
const key = () => 'batch-' + randomBytes(16).toString('hex');
async function setup({ separateDay = false, balances = false } = {}) {
  const repo = await memoryBookingRepository();
  let current = now;
  const clock = () => current;
  const bookings = createBookingService(
    repo,
    clock,
    paymentConfig.SESSION_SECRET,
  );
  const provider = fakeStripe(),
    payments = createPaymentService(repo, provider, paymentConfig, clock);
  const first = await bookings.createHold(validHold),
    second = await bookings.createHold({
      ...validHold,
      ...(separateDay ? { startAt: '2026-12-04T14:00:00Z' } : {}),
    });
  const holds = [first, second],
    refs = holds.map((h) => h.ref),
    tokens = Object.fromEntries(holds.map((h) => [h.ref, h.manageToken]));
  if (balances)
    for (const hold of holds) {
      const checkout = await payments.checkout(hold.ref, hold.manageToken);
      await payments.handleEvent(
        paidEvent(
          provider.sessions.get(checkout.sessionId),
          'evt_deposit_' + hold.id,
        ),
      );
    }
  return {
    repo,
    bookings,
    provider,
    payments,
    holds,
    refs,
    tokens,
    advance: (minutes) => (current = now.plus({ minutes })),
  };
}
describe('combined Stripe payments', () => {
  it('stops checkout if a shown deposit became a different balance before submission', async () => {
    const ctx = await setup();
    const app = createApp({
      config: parseEnv(paymentConfig),
      catalog: fixtureCatalog(),
      bookingRepository: ctx.repo,
      stripeProvider: ctx.provider,
    });
    const agent = request.agent(app);
    const page = await agent.get('/pay').expect(200);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: validHold.email })
      .expect(200);
    Object.assign(ctx.repo.rows[0], {
      status: 'confirmed',
      paymentStatus: 'deposit_paid',
      paidCents: 3000,
      balanceCents: 15000,
    });
    await agent
      .post('/api/pay/all')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(409);
    expect(ctx.provider.calls.create).toHaveLength(0);
    expect(ctx.repo.batchRows).toHaveLength(0);
  });
  it.each([false, true])(
    'expires abandoned combined attempts through cron (balances %s)',
    async (balances) => {
      const ctx = await setup({ balances });
      const id = key();
      await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, id);
      ctx.advance(31);
      await expireHolds(ctx.repo, ctx.bookings, now.plus({ minutes: 31 }));
      expect(ctx.repo.batchRows[0].status).toBe('expired');
      expect(ctx.repo.rows.map((row) => row.status)).toEqual(
        balances ? ['confirmed', 'confirmed'] : ['expired', 'expired'],
      );
      expect(ctx.repo.rows.map((row) => row.paidCents)).toEqual(
        balances ? [3000, 3000] : [0, 0],
      );
    },
  );
  it('reconciles a refund that arrived before the paid Checkout webhook', async () => {
    const ctx = await setup();
    const checkout = await ctx.payments.checkoutBatch(
      ctx.refs,
      ctx.tokens,
      key(),
    );
    const session = ctx.provider.sessions.get(checkout.sessionId);
    ctx.provider.refundRows.push({
      id: 're_before_payment',
      status: 'succeeded',
      currency: 'usd',
      amount: 3000,
      payment_intent: session.payment_intent,
      metadata: {},
      created: 1,
    });
    ctx.provider.inspectPayment = async () => ({
      method: 'card',
      refunded: 3000,
    });
    await ctx.payments.handleEvent({
      id: 'evt_refund_before_payment',
      type: 'charge.refunded',
      data: {
        object: {
          object: 'charge',
          payment_intent: session.payment_intent,
          currency: 'usd',
          amount_refunded: 3000,
        },
      },
    });
    await ctx.payments.handleEvent(paidEvent(session));
    await ctx.payments.handleEvent(paidEvent(session));
    expect(ctx.repo.rows.map((row) => row.paidCents)).toEqual([0, 3000]);
    expect(
      ctx.repo.paymentRows.filter((row) => row.type === 'refund'),
    ).toHaveLength(1);
  });
  it.each([false, true])(
    'charges one server total and allocates exactly once (balances %s)',
    async (balances) => {
      const ctx = await setup({ balances });
      const id = key();
      const result = await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, id);
      const session = ctx.provider.sessions.get(result.sessionId);
      expect(session.amount_total).toBe(balances ? 30000 : 6000);
      const calls = ctx.provider.calls.create.length;
      await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, id);
      expect(ctx.provider.calls.create).toHaveLength(calls);
      await Promise.all(
        Array.from({ length: 5 }, () =>
          ctx.payments.handleEvent(paidEvent(session)),
        ),
      );
      await ctx.payments.handleEvent(paidEvent(session, 'evt_repeated_object'));
      expect(
        ctx.repo.paymentRows.filter(
          (p) => p.stripePaymentIntentId === session.payment_intent,
        ),
      ).toHaveLength(2);
      expect(ctx.repo.rows.map((r) => r.paidCents)).toEqual(
        balances ? [18000, 18000] : [3000, 3000],
      );
      expect(ctx.repo.rows.every((r) => r.status === 'confirmed')).toBe(true);
    },
  );
  it('rejects tampered amounts/currency and unowned references without charging', async () => {
    const ctx = await setup();
    await expect(
      ctx.payments.checkoutBatch(ctx.refs, {}, key()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const result = await ctx.payments.checkoutBatch(
      ctx.refs,
      ctx.tokens,
      key(),
    );
    const session = ctx.provider.sessions.get(result.sessionId);
    for (const change of [{ currency: 'eur' }, { amount_total: 1 }])
      await expect(
        ctx.payments.handleEvent(paidEvent({ ...session, ...change })),
      ).rejects.toMatchObject({ code: 'INVALID_PAYMENT' });
    expect(ctx.repo.paymentRows).toHaveLength(0);
  });
  it('blocks individual checkout and proof while a combined checkout is active', async () => {
    const ctx = await setup();
    await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, key());
    await expect(
      ctx.payments.checkout(ctx.refs[0], ctx.tokens[ctx.refs[0]]),
    ).rejects.toMatchObject({ code: 'CHECKOUT_OPEN' });
    await expect(
      ctx.bookings.submitPaymentProof(ctx.holds[0].id, {
        method: 'zelle',
        path: 'receipt.webp',
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_OPEN' });
  });
  it('rolls back the entire combined reservation if any payment is already open', async () => {
    const ctx = await setup();
    await ctx.payments.checkout(ctx.refs[1], ctx.tokens[ctx.refs[1]]);
    await expect(
      ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, key()),
    ).rejects.toMatchObject({ code: 'PAYMENTS_CHANGED' });
    expect(ctx.repo.batchRows).toHaveLength(0);
    expect(ctx.repo.attemptRows).toHaveLength(1);
  });
  it('does not confirm unpaid completion, then confirms asynchronous payment', async () => {
    const ctx = await setup();
    const checkout = await ctx.payments.checkoutBatch(
      ctx.refs,
      ctx.tokens,
      key(),
    );
    const session = ctx.provider.sessions.get(checkout.sessionId);
    const unpaid = paidEvent(session);
    unpaid.data.object.payment_status = 'unpaid';
    await ctx.payments.handleEvent(unpaid);
    expect(ctx.repo.rows.every((r) => r.status === 'pending_payment')).toBe(
      true,
    );
    await ctx.payments.handleEvent({
      ...paidEvent(session, 'evt_async'),
      type: 'checkout.session.async_payment_succeeded',
    });
    expect(ctx.repo.rows.every((r) => r.status === 'confirmed')).toBe(true);
  });
  it('cancels an unpaid combined checkout and releases initial chairs', async () => {
    const ctx = await setup();
    const id = key();
    await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, id);
    await ctx.payments.cancelBatch(id);
    expect(ctx.repo.rows.map((r) => r.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
    expect(ctx.repo.batchRows[0].status).toBe('expired');
    expect(ctx.repo.paymentRows).toHaveLength(0);
  });
  it('late payment refunds only the unavailable booking and retries failed refunds safely', async () => {
    const ctx = await setup({ separateDay: true });
    const id = key();
    const checkout = await ctx.payments.checkoutBatch(ctx.refs, ctx.tokens, id);
    const session = ctx.provider.sessions.get(checkout.sessionId);
    ctx.advance(31);
    await ctx.bookings.expirePaymentBatch(id);
    for (let i = 0; i < 3; i++) await ctx.bookings.createHold(validHold);
    ctx.provider.failRefund = true;
    await expect(ctx.payments.handleEvent(paidEvent(session))).rejects.toThrow(
      'Temporary Stripe failure',
    );
    await ctx.payments.handleEvent(paidEvent(session));
    expect(ctx.repo.rows[0]).toMatchObject({
      status: 'payment_conflict',
      paymentStatus: 'refunded',
      paidCents: 0,
    });
    expect(ctx.repo.rows[1]).toMatchObject({
      status: 'confirmed',
      paidCents: 3000,
    });
    expect(
      ctx.repo.paymentRows.filter((p) => p.type === 'refund'),
    ).toHaveLength(1);
    expect(ctx.provider.refundRows[0]).toMatchObject({
      amount: 3000,
      metadata: { bookingId: String(ctx.holds[0].id) },
    });
    await ctx.payments.handleEvent({
      id: 'evt_refund',
      type: 'charge.refunded',
      data: {
        object: {
          object: 'charge',
          payment_intent: session.payment_intent,
          currency: 'usd',
          amount_refunded: 3000,
        },
      },
    });
    expect(
      ctx.repo.paymentRows.filter((p) => p.type === 'refund'),
    ).toHaveLength(1);
  });
  it('reconciles external partial/full refunds once across the allocations', async () => {
    const ctx = await setup({ balances: true });
    const checkout = await ctx.payments.checkoutBatch(
      ctx.refs,
      ctx.tokens,
      key(),
    );
    const session = ctx.provider.sessions.get(checkout.sessionId);
    await ctx.payments.handleEvent(paidEvent(session));
    const event = (id, amount) => ({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          object: 'charge',
          currency: 'usd',
          payment_intent: session.payment_intent,
          amount_refunded: amount,
        },
      },
    });
    ctx.provider.refundRows.push({
      id: 're_external_1',
      status: 'succeeded',
      currency: 'usd',
      amount: 10000,
      payment_intent: session.payment_intent,
      metadata: {},
      created: 1,
    });
    await ctx.payments.handleEvent(event('evt_partial', 10000));
    await ctx.payments.handleEvent(event('evt_partial', 10000));
    expect(ctx.repo.rows.map((r) => r.paidCents)).toEqual([8000, 18000]);
    ctx.provider.refundRows.push({
      id: 're_external_2',
      status: 'succeeded',
      currency: 'usd',
      amount: 20000,
      payment_intent: session.payment_intent,
      metadata: {},
      created: 2,
    });
    await ctx.payments.handleEvent(event('evt_full', 30000));
    await ctx.payments.handleEvent(event('evt_old_partial', 10000));
    expect(ctx.repo.rows.map((r) => r.paidCents)).toEqual([3000, 3000]);
    expect(
      ctx.repo.paymentRows
        .filter((p) => p.type === 'refund')
        .reduce((s, p) => s + p.amountCents, 0),
    ).toBe(30000);
  });
  it('offers individual/all options only for contact searches and verifies combined webhook/status access', async () => {
    const ctx = await setup();
    const app = createApp({
      config: parseEnv(paymentConfig),
      catalog: fixtureCatalog(),
      bookingRepository: ctx.repo,
      stripeProvider: ctx.provider,
    });
    const agent = request.agent(app);
    const page = await agent.get('/pay').expect(200);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const one = await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: ctx.refs[0] })
      .expect(200);
    expect(one.text).not.toContain('data-pay-all');
    expect(one.text).not.toContain(ctx.refs[1]);
    const many = await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: validHold.email })
      .expect(200);
    expect(many.text).toContain('data-pay-all');
    expect(many.text).toContain(ctx.refs[0]);
    expect(many.text).toContain(ctx.refs[1]);
    await agent
      .post('/api/pay/all')
      .set('x-csrf-token', csrf)
      .send({ totalCents: 1 })
      .expect(400);
    const checkout = await agent
      .post('/api/pay/all')
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);
    const session = ctx.provider.sessions.get(checkout.body.sessionId);
    expect(session.amount_total).toBe(6000);
    const body = JSON.stringify(paidEvent(session));
    await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', signature(body))
      .send(body)
      .expect(200);
    await agent
      .get('/api/pay/batch-status')
      .query({ session_id: session.id })
      .expect(200)
      .expect((r) => {
        expect(r.body.status).toBe('paid');
        expect(r.body.entries).toHaveLength(2);
        expect(JSON.stringify(r.body)).not.toContain(ctx.holds[0].manageToken);
      });
    await request(app)
      .get('/api/pay/batch-status')
      .query({ session_id: session.id })
      .expect(404);
  });
});
