import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import {
  createBookingService,
  accessToken,
} from '../src/services/bookingService.js';
import { createPaymentService } from '../src/services/paymentService.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import {
  fakeStripe,
  paidEvent,
  signature,
  paymentConfig,
} from './fixtures/stripe.js';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';

async function setup(input = validHold) {
  const repo = await memoryBookingRepository(),
    provider = fakeStripe();
  let current = now;
  const clock = () => current;
  const bookings = createBookingService(
    repo,
    clock,
    paymentConfig.SESSION_SECRET,
  );
  const payments = createPaymentService(repo, provider, paymentConfig, clock);
  const hold = await bookings.createHold(input);
  const checkout = await payments.checkout(hold.ref, hold.manageToken);
  return {
    repo,
    provider,
    bookings,
    payments,
    hold,
    checkout,
    session: provider.sessions.get(checkout.sessionId),
    advance: (minutes) => {
      current = now.plus({ minutes });
    },
    clock,
  };
}
describe('Stripe checkout and payment lifecycle', () => {
  it.each(['deposit', 'full'])(
    'builds server-owned %s checkout and confirms once under duplicate events',
    async (paymentChoice) => {
      const { repo, provider, payments, hold, session } = await setup({
        ...validHold,
        paymentChoice,
        addonIds: [2],
      });
      const expected = paymentChoice === 'deposit' ? 3000 : 22000;
      const request = provider.calls.create[0];
      expect(request.key).toBe('hold-' + hold.id);
      expect(request.params.line_items[0].price_data.unit_amount).toBe(
        expected,
      );
      expect(request.params.metadata).toEqual(
        request.params.payment_intent_data.metadata,
      );
      expect(request.params.customer_email).toBe(validHold.email);
      expect(request.params.cancel_url).toContain('/book?resume=' + hold.ref);
      expect(request.params.expires_at).toBe(
        Math.floor(repo.rows[0].holdExpiresAt.getTime() / 1000),
      );
      await payments.checkout(hold.ref, hold.manageToken);
      expect(provider.sessions.size).toBe(1);
      await Promise.all(
        Array.from({ length: 10 }, () =>
          payments.handleEvent(paidEvent(session)),
        ),
      );
      await payments.handleEvent(paidEvent(session, 'evt_duplicate_object'));
      expect(repo.rows[0]).toMatchObject({
        status: 'confirmed',
        paymentStatus:
          paymentChoice === 'full' ? 'paid_in_full' : 'deposit_paid',
        paidCents: expected,
        balanceCents: 22000 - expected,
      });
      expect(repo.paymentRows).toHaveLength(1);
      expect(repo.notificationRows).toHaveLength(1);
      expect(repo.jobRows.filter((j) => j.type === 'email')).toHaveLength(1);
    },
  );
  it('defers unpaid completion and confirms asynchronous payment success', async () => {
    const { repo, payments, session } = await setup();
    const event = paidEvent(session);
    event.data.object.payment_status = 'unpaid';
    await payments.handleEvent(event);
    expect(repo.rows[0].status).toBe('pending_payment');
    const paid = paidEvent(session, 'evt_async');
    paid.type = 'checkout.session.async_payment_succeeded';
    await payments.handleEvent(paid);
    expect(repo.rows[0].status).toBe('confirmed');
  });
  it('expires abandoned holds and confirms late payment if capacity is still free', async () => {
    const { repo, bookings, payments, session, advance, clock } = await setup();
    advance(31);
    expect(await expireHolds(repo, bookings, clock())).toBe(1);
    expect(repo.rows[0].status).toBe('expired');
    await payments.handleEvent(paidEvent(session));
    expect(repo.rows[0].status).toBe('confirmed');
  });
  it('refunds a late payment at capacity and retries a durable refund after provider failure', async () => {
    const { repo, provider, bookings, payments, session, advance, clock } =
      await setup();
    advance(31);
    await expireHolds(repo, bookings, clock());
    await Promise.all(
      Array.from({ length: 3 }, () => bookings.createHold(validHold)),
    );
    provider.failRefund = true;
    await expect(payments.handleEvent(paidEvent(session))).rejects.toThrow(
      'Temporary Stripe failure',
    );
    expect(repo.rows[0].status).toBe('payment_conflict');
    expect(repo.jobRows.find((j) => j.type === 'refundConflict').status).toBe(
      'failed',
    );
    await payments.handleEvent(paidEvent(session));
    expect(repo.rows[0]).toMatchObject({
      status: 'payment_conflict',
      paymentStatus: 'refunded',
      paidCents: 0,
    });
    expect(repo.paymentRows.filter((p) => p.type === 'refund')).toHaveLength(1);
    expect(provider.calls.refund[0].key).toBe(provider.calls.refund[1].key);
    expect(repo.jobRows.find((j) => j.type === 'refundConflict').status).toBe(
      'done',
    );
  });
  it('records deposit and exact balance once, rejecting forged access and extra price fields', async () => {
    const { repo, payments, hold, session, provider } = await setup();
    await payments.handleEvent(paidEvent(session));
    await expect(
      payments.checkout(hold.ref, 'forged', true),
    ).rejects.toMatchObject({ status: 404 });
    const balance = await payments.checkout(hold.ref, hold.manageToken, true);
    const balanceSession = provider.sessions.get(balance.sessionId);
    expect(balanceSession.amount_total).toBe(15000);
    expect(balanceSession.metadata.paymentType).toBe('balance');
    await payments.handleEvent(paidEvent(balanceSession, 'evt_balance'));
    await payments.handleEvent(
      paidEvent(balanceSession, 'evt_balance_duplicate'),
    );
    expect(repo.rows[0]).toMatchObject({
      paymentStatus: 'paid_in_full',
      paidCents: 18000,
      balanceCents: 0,
    });
    expect(repo.paymentRows).toHaveLength(2);
    await expect(
      payments.checkout(hold.ref, hold.manageToken, true),
    ).rejects.toMatchObject({ code: 'BALANCE_UNAVAILABLE' });
  });
  it('handles partial/full refunds, duplicates and out-of-order lower cumulative amounts', async () => {
    const { repo, payments, session } = await setup();
    await payments.handleEvent(paidEvent(session));
    const event = (id, amount) => ({
      id,
      type: 'charge.refunded',
      data: {
        object: {
          id: 'ch_test',
          object: 'charge',
          currency: 'usd',
          payment_intent: session.payment_intent,
          amount_refunded: amount,
        },
      },
    });
    await payments.handleEvent(event('evt_refund1', 1000));
    expect(repo.rows[0]).toMatchObject({
      paidCents: 2000,
      paymentStatus: 'partially_refunded',
      balanceCents: 16000,
    });
    await payments.handleEvent(event('evt_refund2', 3000));
    await payments.handleEvent(event('evt_refund1_late', 1000));
    expect(repo.rows[0]).toMatchObject({
      paidCents: 0,
      paymentStatus: 'refunded',
      balanceCents: 18000,
    });
    expect(
      repo.paymentRows
        .filter((p) => p.type === 'refund')
        .reduce((n, p) => n + p.amountCents, 0),
    ).toBe(3000);
  });
  it('rejects amount/currency/metadata mismatches without committing payment or event', async () => {
    const { repo, payments, session } = await setup();
    for (const patch of [
      { amount_total: 1 },
      { currency: 'ngn' },
      { metadata: { ...session.metadata, paymentType: 'full' } },
    ]) {
      const event = paidEvent({ ...session, ...patch });
      await expect(payments.handleEvent(event)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(repo.paymentRows).toHaveLength(0);
    expect(repo.eventRows).toHaveLength(0);
    expect(repo.rows[0].status).toBe('pending_payment');
  });
  it('expires cancelled checkout and preserves a paid session racing with cancellation', async () => {
    const first = await setup();
    await first.payments.cancel(first.hold.ref, first.hold.manageToken);
    expect(first.repo.rows[0].status).toBe('cancelled');
    expect(first.provider.calls.expire).toHaveLength(1);
    const second = await setup();
    second.session.status = 'complete';
    second.session.payment_status = 'paid';
    expect(
      await second.payments.cancel(second.hold.ref, second.hold.manageToken),
    ).toMatchObject({ paid: true });
    expect(second.repo.rows[0].status).toBe('pending_payment');
  });
  it.each([
    'checkout.session.expired',
    'checkout.session.async_payment_failed',
  ])('handles %s without expiring confirmed bookings', async (type) => {
    const { repo, payments, session } = await setup();
    await payments.handleEvent(paidEvent(session));
    await payments.handleEvent({
      id: 'evt_expiry',
      type,
      data: { object: session },
    });
    expect(repo.rows[0].status).toBe('confirmed');
  });
});
describe('signed raw webhook and private payment routes', () => {
  it('verifies exact raw bytes without CSRF, rejects bad signatures and keeps status private', async () => {
    const repo = await memoryBookingRepository(),
      provider = fakeStripe();
    const app = createApp({
      config: parseEnv(paymentConfig),
      catalog: fixtureCatalog(),
      bookingRepository: repo,
      stripeProvider: provider,
    });
    const agent = request.agent(app);
    const page = await agent.get('/book').expect(200);
    const csrf = page.text.match(/data-csrf="([^"]+)"/)[1];
    const start = DateTime.now()
      .setZone('America/New_York')
      .plus({ days: 3 })
      .startOf('day')
      .set({ hour: 10 })
      .toUTC()
      .toISO();
    const first = await agent
      .post('/api/bookings/hold')
      .set('x-csrf-token', csrf)
      .send({
        ...validHold,
        startAt: start,
        requestKey: 'eaee1ec7-26dc-4e20-b918-987ac404d18c',
      })
      .expect(201);
    const repeated = await agent
      .post('/api/bookings/hold')
      .set('x-csrf-token', csrf)
      .send({
        ...validHold,
        startAt: start,
        requestKey: 'eaee1ec7-26dc-4e20-b918-987ac404d18c',
      })
      .expect(201);
    expect(repeated.body.ref).toBe(first.body.ref);
    expect(repo.rows).toHaveLength(1);
    const ref = first.body.ref;
    await agent
      .post(`/api/bookings/${ref}/checkout`)
      .set('x-csrf-token', csrf)
      .send({ amount: 1 })
      .expect(400);
    const checkout = await agent
      .post(`/api/bookings/${ref}/checkout`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);
    const body =
      ' ' +
      JSON.stringify(paidEvent(provider.sessions.get(checkout.body.sessionId)));
    await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', 'bad')
      .send(body)
      .expect(400);
    await request(app)
      .post('/webhooks/stripe')
      .set('content-type', 'application/json')
      .set('stripe-signature', signature(body))
      .send(body)
      .expect(200);
    await agent
      .get('/api/bookings/payment-status?session_id=' + checkout.body.sessionId)
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('confirmed'));
    await request(app)
      .get('/api/bookings/payment-status?session_id=' + checkout.body.sessionId)
      .expect(404);
    const token = accessToken(ref, paymentConfig.SESSION_SECRET);
    await request(app)
      .get('/booking/' + token)
      .expect(200)
      .expect((r) => expect(r.headers['cache-control']).toBe('no-store'));
  });
});
