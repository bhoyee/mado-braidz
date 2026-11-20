import { describe, it, expect } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { presentAppointment } from '../src/services/adminAppointment.js';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import {
  createAdminAuthService,
  newTotpSecret,
  totpCode,
} from '../src/services/adminAuthService.js';
import { createBookingService } from '../src/services/bookingService.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import { memoryAdminRepository, futureStart } from './fixtures/admin.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig, fakeStripe, paidEvent } from './fixtures/stripe.js';
import { createPaymentService } from '../src/services/paymentService.js';
const owner = {
  id: 1,
  role: 'owner',
  email: 'owner@example.test',
  name: 'Studio Owner',
  authVersion: 0,
};
const password = 'Secure-owner-test-password!';
const config = parseEnv({ ...paymentConfig, UPLOAD_DIR: 'tmp/test-admin' });
async function setup() {
  const repo = await memoryBookingRepository();
  const admins = memoryAdminRepository(repo, {
    ...owner,
    passwordHash: await argon2.hash(password),
  });
  const auth = createAdminAuthService(
    admins,
    config,
    () => now.toMillis(),
    async () => {},
  );
  const service = createBookingService(repo, () => now, config.SESSION_SECRET);
  return { repo, admins, auth, service };
}
const edit = (startAt = '2026-12-04T14:00:00Z') => ({
  ...validHold,
  startAt,
  adminNotes: 'Client requested a new time.',
  action: 'edit',
  requestKey: randomUUID(),
});
describe('owner authentication', () => {
  it('matches the standard RFC 6238 SHA-1 test vector truncated to six digits', () => {
    expect(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1)).toBe('287082');
  });
  it('locks the account after five failures even across different sessions, and releases after 15 minutes', async () => {
    const { admins } = await setup();
    let time = now.toMillis();
    const auth = createAdminAuthService(admins, config, () => time);
    for (let n = 0; n < 5; n++)
      await expect(
        auth.login(owner.email, 'wrong', '', `ip-${n}`),
      ).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    await expect(auth.login(owner.email, password, '')).rejects.toMatchObject({
      code: 'LOGIN_FAILED',
    });
    time += 16 * 60000;
    expect((await auth.login(owner.email, password, '')).id).toBe(1);
  });
  it('resets once, expires tokens and revokes existing sessions without disabling TOTP', async () => {
    const { admins } = await setup();
    let link;
    const auth = createAdminAuthService(
      admins,
      config,
      () => now.toMillis(),
      async (_email, url) => {
        link = url;
      },
    );
    const grant = await auth.login(owner.email, password, '');
    grant.expiresAt = now.plus({ hours: 8 }).toMillis();
    await auth.requestReset(owner.email);
    const token = link.split('#')[1];
    expect(admins.rows[0].resetTokenHash).not.toBe(token);
    await auth.resetPassword(token, 'Another-secure-password!');
    expect(await auth.authenticate(grant)).toBeNull();
    await expect(auth.resetPassword(token, password)).rejects.toMatchObject({
      code: 'INVALID_RESET',
    });
    await auth.requestReset(owner.email);
    const late = createAdminAuthService(admins, config, () =>
      now.plus({ hours: 1 }).toMillis(),
    );
    await expect(
      late.resetPassword(link.split('#')[1], password),
    ).rejects.toMatchObject({ code: 'INVALID_RESET' });
  });
  it('encrypts TOTP secrets, rejects replayed codes and keeps staff out', async () => {
    const { admins, auth } = await setup();
    const secret = newTotpSecret(),
      step = Math.floor(now.toMillis() / 30000);
    await auth.changeSecurity(1, password, {
      action: 'enable',
      secret,
      code: totpCode(secret, step),
    });
    expect(admins.rows[0].totpSecret).not.toContain(secret);
    await expect(
      auth.login(owner.email, password, totpCode(secret, step)),
    ).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
    const later = createAdminAuthService(
      admins,
      config,
      () => now.toMillis() + 30000,
    );
    expect(
      (await later.login(owner.email, password, totpCode(secret, step + 1))).id,
    ).toBe(1);
    admins.rows[0].role = 'staff';
    await expect(
      later.login(owner.email, password, totpCode(secret, step + 2)),
    ).rejects.toMatchObject({ code: 'LOGIN_FAILED' });
  });
});
describe('owner booking operations', () => {
  it('keeps full-payment checkout amounts correct after an owner changes extras', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold({
      ...validHold,
      paymentChoice: 'full',
    });
    await service.adminEdit(
      hold.id,
      { ...edit(validHold.startAt), changeStyle: true, addonIds: [2] },
      owner,
    );
    const provider = fakeStripe(),
      payments = createPaymentService(repo, provider, config, () => now);
    const checkout = await payments.checkout(hold.ref, hold.manageToken);
    expect(provider.sessions.get(checkout.sessionId).amount_total).toBe(22000);
    expect(repo.rows[0].priceSnapshot.dueTodayCents).toBe(22000);
  });
  it('refunds only the requested allocation of a combined card charge, including a second partial refund', async () => {
    const { repo, service } = await setup();
    const first = await service.createHold(validHold),
      second = await service.createHold(validHold);
    const provider = fakeStripe(),
      payments = createPaymentService(repo, provider, config, () => now);
    const checkout = await payments.checkoutBatch(
      [first.ref, second.ref],
      { [first.ref]: first.manageToken, [second.ref]: second.manageToken },
      'batch-' + randomUUID().replaceAll('-', ''),
    );
    await payments.handleEvent(
      paidEvent(provider.sessions.get(checkout.sessionId)),
    );
    const original = repo.paymentRows.find((p) => p.bookingId === first.id);
    for (const amountCents of [1000, 500]) {
      const input = {
        action: 'refund',
        paymentId: original.id,
        amountCents,
        requestKey: randomUUID(),
        note: 'Owner-approved partial refund',
      };
      await service.adminAction(first.id, input, owner);
      await service.adminAction(first.id, input, owner);
      await payments.runRefunds(first.id);
    }
    expect(repo.rows[0].paidCents).toBe(1500);
    expect(repo.rows[1].paidCents).toBe(3000);
    expect(provider.calls.refund.map((r) => r.payload.amountCents)).toEqual([
      1000, 500,
    ]);
    expect(repo.rows.every((b) => b.status === 'confirmed')).toBe(true);
  });
  it('allows an unpaid owner override to pay its full balance without making the chair temporary', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold, null, {
      admin: owner,
      mode: 'override',
    });
    const provider = fakeStripe(),
      payments = createPaymentService(repo, provider, config, () => now);
    const checkout = await payments.checkout(hold.ref, hold.manageToken, true);
    expect(provider.sessions.get(checkout.sessionId).amount_total).toBe(18000);
    expect(repo.rows[0]).toMatchObject({
      status: 'confirmed',
      holdExpiresAt: null,
    });
    await payments.handleEvent(
      paidEvent(provider.sessions.get(checkout.sessionId)),
    );
    expect(repo.rows[0]).toMatchObject({
      status: 'confirmed',
      paymentStatus: 'paid_in_full',
    });
  });
  it('rechecks time blocks for confirmation and reprices only explicitly changed styles or consultation totals', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    repo.timeBlocks.push({
      startAt: new Date(validHold.startAt),
      endAt: new Date('2026-12-03T18:00:00Z'),
    });
    await expect(
      service.adminAction(
        hold.id,
        { action: 'confirm', requestKey: randomUUID() },
        owner,
      ),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await service.adminEdit(
      hold.id,
      { ...edit(), changeStyle: true, addonIds: [2] },
      owner,
    );
    expect(repo.rows[0].subtotalCents).toBe(22000);
    expect(repo.rows[0].priceSnapshot.addons[0].priceCents).toBe(4000);
    await expect(
      service.adminEdit(hold.id, { ...edit(), quotedTotalCents: 10000 }, owner),
    ).rejects.toThrow('consultation');
  });
  it('moves dates without changing the agreed price and writes before/after audit', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    repo.data.styles[0].variants[0].priceCents = 99900;
    const price = repo.rows[0].subtotalCents;
    await service.adminEdit(hold.id, edit(), owner);
    expect(repo.rows[0].subtotalCents).toBe(price);
    expect(repo.rows[0].startAt.toISOString()).toBe('2026-12-04T14:00:00.000Z');
    expect(repo.auditRows[0]).toMatchObject({
      action: 'edit',
      before: { startAt: new Date(validHold.startAt) },
    });
  });
  it('counts overlapping intervals and buffer, ignores itself, and leaves the original booking intact on rejection', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    for (let n = 0; n < 3; n++)
      await service.createHold({
        ...validHold,
        startAt: '2026-12-04T14:00:00Z',
      });
    await expect(
      service.adminEdit(hold.id, edit('2026-12-04T14:30:00Z'), owner),
    ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    expect(repo.rows[0].startAt.toISOString()).toBe('2026-12-03T14:00:00.000Z');
    await service.adminEdit(hold.id, edit(validHold.startAt), owner);
    expect(repo.rows[0].status).toBe('pending_payment');
  });
  it('rejects closed-hour and off-step moves, stale edits, open checkouts and staff mutation', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    for (const start of ['2026-12-04T04:00:00Z', '2026-12-04T14:15:00Z'])
      await expect(
        service.adminEdit(hold.id, edit(start), owner),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
    await expect(
      service.adminEdit(
        hold.id,
        { ...edit(), expectedUpdatedAt: '2020-01-01T00:00:00Z' },
        owner,
      ),
    ).rejects.toMatchObject({ code: 'STALE_BOOKING' });
    await expect(
      service.adminEdit(hold.id, edit(), { ...owner, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    repo.attemptRows.push({ bookingId: hold.id, status: 'open' });
    await expect(service.adminEdit(hold.id, edit(), owner)).rejects.toThrow(
      'checkout is open',
    );
  });
  it('records in-person payment exactly once and refuses overpayment', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    const input = {
      action: 'payment',
      amountCents: 3000,
      method: 'cash',
      requestKey: randomUUID(),
      note: 'Received at studio',
    };
    await Promise.all([
      service.adminAction(hold.id, input, owner),
      service.adminAction(hold.id, input, owner),
    ]);
    expect(repo.paymentRows).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({
      paidCents: 3000,
      status: 'confirmed',
      balanceCents: 15000,
    });
    await expect(
      service.adminAction(
        hold.id,
        { ...input, requestKey: randomUUID(), amountCents: 99999 },
        owner,
      ),
    ).rejects.toThrow('exceeds');
  });
  it('records manual refunds once without automatically cancelling the chair', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    await service.adminAction(
      hold.id,
      {
        action: 'payment',
        amountCents: 3000,
        method: 'cash',
        requestKey: randomUUID(),
      },
      owner,
    );
    const refund = {
      action: 'refund',
      paymentId: 1,
      amountCents: 1000,
      requestKey: randomUUID(),
      note: 'Returned cash',
    };
    await service.adminAction(hold.id, refund, owner);
    await service.adminAction(hold.id, refund, owner);
    expect(repo.rows[0]).toMatchObject({
      status: 'confirmed',
      paidCents: 2000,
      paymentStatus: 'partially_refunded',
    });
    expect(repo.paymentRows).toHaveLength(2);
    await expect(
      service.adminAction(
        hold.id,
        { ...refund, amountCents: 2500, requestKey: randomUUID() },
        owner,
      ),
    ).rejects.toThrow('exceeds');
  });
  it('creates confirmed owner overrides and manual payments atomically, with capacity enforced', async () => {
    const { repo, service } = await setup();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.createHold(
          { ...validHold, checkoutRequestKey: randomUUID() },
          null,
          { admin: owner, mode: 'override' },
        ),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(
      repo.rows.every((b) => b.source === 'admin' && b.status === 'confirmed'),
    ).toBe(true);
    const manual = await service.createHold(
      {
        ...validHold,
        startAt: '2026-12-04T14:00:00Z',
        checkoutRequestKey: randomUUID(),
      },
      null,
      { admin: owner, mode: 'manual', amountCents: 3000, method: 'cash' },
    );
    expect((await repo.bookingById(manual.id)).paidCents).toBe(3000);
    const count = repo.rows.length;
    await expect(
      service.createHold(
        { ...validHold, startAt: '2026-12-05T14:00:00Z' },
        null,
        { admin: owner, mode: 'manual', amountCents: 1, method: 'cash' },
      ),
    ).rejects.toThrow('at least');
    expect(repo.rows).toHaveLength(count);
  });
  it('cancels queued reminders and releases capacity on owner cancellation', async () => {
    const { repo, service } = await setup();
    const hold = await service.createHold(validHold);
    await service.adminAction(
      hold.id,
      { action: 'confirm', requestKey: randomUUID() },
      owner,
    );
    await repo.queueJob({
      type: 'reminder',
      payload: { bookingId: hold.id },
      dedupeKey: 'reminder:test',
      status: 'pending',
    });
    await service.adminAction(
      hold.id,
      {
        action: 'cancel',
        note: 'Requested by client',
        requestKey: randomUUID(),
      },
      owner,
    );
    expect(repo.rows[0].status).toBe('cancelled');
    expect(repo.jobRows.find((j) => j.type === 'reminder').status).toBe(
      'cancelled',
    );
  });
});
describe('owner portal routes', () => {
  it('keeps password-only owner login clean and shows an authenticator field only when enabled', async () => {
    const { repo, admins } = await setup();
    const app = createApp({
      config,
      bookingRepository: repo,
      adminRepository: admins,
      catalog: fixtureCatalog(),
      stripeProvider: fakeStripe(),
    });
    const login = await request(app).get('/admin/login').expect(200);
    expect(login.text).toContain('owner-entry');
    expect(login.text).not.toContain('name="code"');
    admins.rows[0].totpSecret = 'enabled-test-record';
    expect((await request(app).get('/admin/login')).text).toContain(
      'name="code"',
    );
  });
  it('shows all upcoming visits and active pending payments together, with owner-only financial reports', async () => {
    const { repo, admins, service } = await setup();
    await service.createHold(validHold);
    const base = { ...repo.rows[0] };
    const today = DateTime.now().setZone('America/New_York').startOf('day');
    repo.rows.splice(0);
    for (let n = 10; n >= 1; n--) {
      repo.rows.push({
        ...base,
        id: n,
        ref: 'OV-VISIT-' + n,
        status: 'confirmed',
        startAt: today.plus({ days: n }).toJSDate(),
        balanceCents: 15000,
        subtotalCents: 18000,
        paidCents: 3000,
      });
      repo.rows.push({
        ...base,
        id: 100 + n,
        ref: 'OV-HOLD-' + n,
        status: 'pending_payment',
        startAt: today.plus({ days: n }).toJSDate(),
        holdExpiresAt: new Date(Date.now() + 3600000),
      });
    }
    repo.rows.push({
      ...base,
      id: 200,
      ref: 'OV-EXPIRED-HOLD',
      status: 'pending_payment',
      startAt: today.toJSDate(),
      holdExpiresAt: new Date(0),
    });
    repo.rows.push({
      ...base,
      id: 201,
      ref: 'OV-PAST',
      status: 'confirmed',
      startAt: today.minus({ days: 1 }).toJSDate(),
      balanceCents: 0,
    });
    const paidAt = new Date(Date.now() - 1000);
    repo.proofRows.push(
      { id: 1, bookingId: 101, status: 'pending', method: 'zelle' },
      { id: 2, bookingId: 102, status: 'pending', method: 'cashapp' },
    );
    repo.paymentRows.push(
      {
        id: 1,
        bookingId: 1,
        type: 'deposit',
        method: 'card',
        amountCents: 6000,
        createdAt: paidAt,
      },
      {
        id: 2,
        bookingId: 1,
        type: 'refund',
        method: 'card',
        amountCents: 1000,
        createdAt: paidAt,
      },
    );
    const app = createApp({
      config,
      bookingRepository: repo,
      adminRepository: admins,
      catalog: fixtureCatalog(),
      stripeProvider: fakeStripe(),
    });
    const agent = request.agent(app);
    await agent.get('/admin/payments?period=week').expect(303);
    await agent.get('/admin/balances').expect(303);
    const login = await agent.get('/admin/login');
    await agent
      .post('/admin/login')
      .send({
        email: owner.email,
        password,
        _csrf: login.text.match(/name="_csrf" value="([^"]+)"/)[1],
      })
      .expect(303);
    const overview = await agent.get('/admin').expect(200);
    for (const prefix of ['OV-VISIT-', 'OV-HOLD-']) {
      expect(overview.text).toContain(prefix + '6');
      expect(overview.text).toContain(prefix + '10');
      expect(overview.text.indexOf(prefix + '1')).toBeLessThan(
        overview.text.indexOf(prefix + '2'),
      );
    }
    expect(overview.text).not.toContain('OV-EXPIRED-HOLD');
    expect(overview.text).not.toContain('OV-PAST');
    expect(overview.text).not.toContain('Chairs on hold');
    expect(overview.text).toContain('Zelle');
    expect(overview.text).toContain('Cash App');
    expect(overview.text).toContain('Awaiting payment approval');
    expect(overview.text).toContain('Upcoming appointments');
    expect(overview.text).toContain('/admin/balances');
    const receipts = await agent
      .get('/admin/payments?period=month')
      .expect(200);
    expect(receipts.text).toContain('<h2>$50</h2>');
    expect(receipts.text).toContain('Refund');
    expect(receipts.text).toContain(validHold.email);
    const balances = await agent.get('/admin/balances').expect(200);
    expect(balances.text).toContain('OV-VISIT-10');
    expect(balances.text).not.toContain('OV-HOLD-');
    const all = await agent
      .get(
        '/admin/bookings?status=confirmed&order=nearest&from=' +
          today.toISODate(),
      )
      .expect(200);
    expect(all.text).toContain('OV-VISIT-10');
    await agent.get('/admin/payments?period=invalid').expect(400);
  });
  it('requires session login, rejects Basic auth, renders owner screens and protects mutations with CSRF', async () => {
    const { repo, admins } = await setup();
    const service = createBookingService(
      repo,
      undefined,
      config.SESSION_SECRET,
    );
    await service.createHold({ ...validHold, startAt: futureStart() }, null, {
      admin: owner,
      mode: 'override',
    });
    const app = createApp({
      config,
      bookingRepository: repo,
      adminRepository: admins,
      catalog: fixtureCatalog(),
      stripeProvider: fakeStripe(),
    });
    await request(app).get('/admin').expect(303);
    await request(app)
      .get('/admin/payment-reviews')
      .auth(owner.email, password)
      .expect(303);
    const agent = request.agent(app);
    const login = await agent.get('/admin/login').expect(200);
    const token = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await agent
      .post('/admin/login')
      .send({ email: owner.email, password })
      .expect(403);
    await agent
      .post('/admin/login')
      .send({ email: owner.email, password, _csrf: token })
      .expect(303);
    for (const page of [
      '/admin',
      '/admin/bookings',
      '/admin/bookings/1',
      '/admin/bookings/1/edit',
      '/admin/bookings/new',
      '/admin/calendar',
      '/admin/security',
      '/admin/audit',
      '/admin/payment-reviews',
    ]) {
      const response = await agent.get(page).expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain('Owner studio');
    }
    await agent
      .post('/admin/bookings/1/action')
      .send({ action: 'cancel', requestKey: randomUUID() })
      .expect(403);
    await agent
      .get('/admin/bookings/export')
      .expect(200)
      .expect('Content-Type', /csv/);
    const newPage = await agent.get('/admin/bookings/1');
    const csrf = newPage.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await agent
      .post('/admin/bookings/1/action')
      .set('Accept', 'application/json')
      .send({
        action: 'note',
        note: 'Private note',
        _csrf: csrf,
        requestKey: randomUUID(),
      })
      .expect(200);
    expect(repo.rows[0].adminNotes).toBe('Private note');
    admins.rows[0].role = 'staff';
    await agent.get('/admin/bookings/1').expect(303);
    await agent
      .post('/admin/bookings/1/action')
      .set('Accept', 'application/json')
      .send({ action: 'refund', _csrf: csrf })
      .expect(401);
  });
});

describe('appointment table presentation', () => {
  it('uses the booked style, size and length instead of a reference or changed catalog name', () => {
    const row = presentAppointment({
      booking: {
        priceSnapshot: JSON.stringify({
          styleName: 'Knotless Braids',
          size: 'small',
          length: 'waist',
        }),
      },
      styleName: 'Renamed style',
      paymentMethod: 'card',
      paymentProvider: 'stripe',
    });
    expect(row.styleName).toBe('Knotless Braids');
    expect(row.styleOption).toBe('Small · Waist');
    expect(row.paymentSource).toBe('Stripe / card');
  });
  it('distinguishes transfer review, in-person methods and an unrecorded payment', () => {
    for (const [method, source] of [
      ['cashapp', 'Cash App'],
      ['zelle', 'Zelle'],
      ['cash', 'Cash'],
      ['card', 'Card (in person)'],
      [null, 'Not recorded'],
    ]) {
      const row = presentAppointment({
        booking: { priceSnapshot: {} },
        paymentMethod: method,
        paymentProvider: 'manual',
        paymentReview: 1,
      });
      expect(row.paymentSource).toBe(source);
      expect(row.paymentReview).toBe(true);
    }
  });
});
