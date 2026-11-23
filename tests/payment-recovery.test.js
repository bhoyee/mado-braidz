import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createBookingService } from '../src/services/bookingService.js';
import { createPaymentService } from '../src/services/paymentService.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import { fakeStripe, paidEvent, paymentConfig } from './fixtures/stripe.js';

async function setup() {
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
  const hold = await bookings.createHold(validHold);
  const checkout = await payments.checkout(hold.ref, hold.manageToken);
  const session = provider.sessions.get(checkout.sessionId);
  return {
    repo,
    provider,
    bookings,
    payments,
    hold,
    session,
    clock,
    advance: (minutes) => (current = now.plus({ minutes })),
    pay: () =>
      Object.assign(session, { status: 'complete', payment_status: 'paid' }),
    confirmations: () =>
      repo.jobRows.filter((j) => j.payload.template === 'booking-confirmation'),
  };
}

describe('payment recovery without a webhook', () => {
  it('confirms a paid checkout once, even when the webhook arrives later', async () => {
    const f = await setup();
    f.pay();
    expect(await f.payments.reconcile()).toMatchObject({ confirmed: 1 });
    expect(f.repo.rows[0]).toMatchObject({
      status: 'confirmed',
      paymentStatus: 'deposit_paid',
      paidCents: 3000,
    });
    await f.payments.handleEvent(paidEvent(f.session, 'evt_late'));
    await f.payments.reconcile();
    expect(f.repo.paymentRows).toHaveLength(1);
    expect(f.confirmations()).toHaveLength(1);
    expect(f.provider.calls.refund).toHaveLength(0);
  });
  it('does nothing after a webhook already confirmed the booking', async () => {
    const f = await setup();
    f.pay();
    await f.payments.handleEvent(paidEvent(f.session));
    expect(await f.payments.reconcile()).toMatchObject({ confirmed: 0 });
    expect(f.repo.paymentRows).toHaveLength(1);
  });
  it('keeps the chair of a paid client when the hold has just ended', async () => {
    const f = await setup();
    f.pay();
    f.advance(45);
    await f.payments.reconcile();
    await expireHolds(f.repo, f.bookings, f.clock());
    expect(f.repo.rows[0].status).toBe('confirmed');
  });
  it.each([
    ['open', 'unpaid'],
    ['complete', 'unpaid'],
  ])('never confirms a %s and %s checkout', async (status, payment) => {
    const f = await setup();
    Object.assign(f.session, { status, payment_status: payment });
    expect(await f.payments.reconcile()).toMatchObject({ confirmed: 0 });
    expect(f.repo.rows[0].status).toBe('pending_payment');
    expect(f.repo.paymentRows).toHaveLength(0);
  });
  it('releases the chair when Stripe reports an expired checkout', async () => {
    const f = await setup();
    f.session.status = 'expired';
    expect(await f.payments.reconcile()).toMatchObject({ expired: 1 });
    expect(f.repo.rows[0].status).toBe('expired');
  });
  it.each([
    ['amount_total', 100],
    ['currency', 'eur'],
    ['metadata', { application: 'other' }],
  ])('rejects a session with the wrong %s', async (key, value) => {
    const f = await setup();
    f.pay();
    f.session[key] = value;
    expect(await f.payments.reconcile()).toMatchObject({
      confirmed: 0,
      failed: 1,
    });
    expect(f.repo.rows[0].status).toBe('pending_payment');
    expect(f.repo.paymentRows).toHaveLength(0);
  });
  it('carries on past a Stripe failure and retries next time', async () => {
    const f = await setup();
    f.pay();
    const retrieve = f.provider.retrieveSession;
    f.provider.retrieveSession = async () => {
      throw new Error('Stripe unavailable');
    };
    expect(await f.payments.reconcile()).toMatchObject({ failed: 1 });
    f.provider.retrieveSession = retrieve;
    expect(await f.payments.reconcile()).toMatchObject({ confirmed: 1 });
  });
  it('confirms from the waiting page, for the booking owner only', async () => {
    const f = await setup();
    f.pay();
    await expect(
      f.payments.status(f.session.id, 'wrong-token'),
    ).rejects.toThrow();
    expect(f.repo.rows[0].status).toBe('pending_payment');
    const state = await f.payments.status(f.session.id, f.hold.manageToken);
    expect(state.status).toBe('confirmed');
  });
  it('limits how often the waiting page asks Stripe', async () => {
    const f = await setup();
    let calls = 0;
    const retrieve = f.provider.retrieveSession;
    f.provider.retrieveSession = async (id) => {
      calls++;
      return retrieve(id);
    };
    for (let i = 0; i < 5; i++)
      await f.payments.status(f.session.id, f.hold.manageToken);
    expect(calls).toBe(1);
  });
  it('recovers a combined payment once', async () => {
    const f = await setup();
    const second = await f.bookings.createHold({
      ...validHold,
      requestKey: undefined,
      email: 'second@example.test',
    });
    f.session.status = 'expired';
    await f.payments.reconcile();
    const third = await f.bookings.createHold({
      ...validHold,
      email: 'third@example.test',
    });
    const ids = [second, third];
    const { sessionId } = await f.payments.checkoutBatch(
      ids.map((b) => b.ref),
      Object.fromEntries(ids.map((b) => [b.ref, b.manageToken])),
      'batch-' + 'a'.repeat(32),
      undefined,
    );
    Object.assign(f.provider.sessions.get(sessionId), {
      status: 'complete',
      payment_status: 'paid',
    });
    expect(await f.payments.reconcile()).toMatchObject({ confirmed: 1 });
    await f.payments.handleEvent(
      paidEvent(f.provider.sessions.get(sessionId), 'evt_batch_late'),
    );
    await f.payments.reconcile();
    expect(f.repo.paymentRows).toHaveLength(2);
    expect(
      f.repo.rows.filter((row) => row.status === 'confirmed'),
    ).toHaveLength(2);
  });
});

describe('canonical address', () => {
  const app = () =>
    createApp({
      config: parseEnv({ ...paymentConfig, APP_URL: 'https://salon.example' }),
      catalog: fixtureCatalog(),
    });
  it('redirects www pages with their path and query', async () => {
    const response = await request(app())
      .get('/styles?q=locs')
      .set('Host', 'www.salon.example')
      .expect(301);
    expect(response.headers.location).toBe(
      'https://salon.example/styles?q=locs',
    );
    const odd = await request(app())
      .get('//evil.example/x')
      .set('Host', 'www.salon.example')
      .expect(301);
    expect(new URL(odd.headers.location).host).toBe('salon.example');
  });
  it('leaves the main address, other hosts and webhooks alone', async () => {
    await request(app())
      .get('/health')
      .set('Host', 'salon.example')
      .expect(200);
    await request(app())
      .get('/health')
      .set('Host', 'www.other.example')
      .expect(200);
    const hook = await request(app())
      .post('/webhooks/stripe')
      .set('Host', 'www.salon.example');
    expect(hook.status).not.toBe(301);
  });
});

it('shows one spelling of the salon name', async () => {
  const data = await fixtureCatalog().load();
  data.settings.business.name = 'Mado African Braidz';
  const { text } = await request(
    createApp({
      config: parseEnv(paymentConfig),
      catalog: { load: async () => data },
    }),
  ).get('/policies');
  expect(text).not.toMatch(/African Braidz/i);
  expect(text).toContain('Mado African Braids');
});
