import { describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createBookingService } from '../src/services/bookingService.js';
import {
  appointmentActions,
  appointmentHistory,
} from '../src/services/adminAppointmentDetail.js';
import { memoryBookingRepository, validHold } from './fixtures/booking.js';
import { memoryAdminRepository, futureStart } from './fixtures/admin.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig, fakeStripe } from './fixtures/stripe.js';

const config = parseEnv({ ...paymentConfig, UPLOAD_DIR: 'tmp/test-appts' });
const password = 'Secure-owner-test-password!';
const owner = {
  id: 1,
  role: 'owner',
  email: 'owner@example.test',
  name: 'Studio Owner',
  authVersion: 0,
};
async function setup() {
  const repo = await memoryBookingRepository();
  const admins = memoryAdminRepository(repo, {
    ...owner,
    passwordHash: await argon2.hash(password),
  });
  const service = createBookingService(repo, undefined, config.SESSION_SECRET);
  const booking = await service.createHold(
    { ...validHold, startAt: futureStart() },
    null,
    { admin: owner, mode: 'override' },
  );
  const app = createApp({
    config,
    bookingRepository: repo,
    adminRepository: admins,
    catalog: fixtureCatalog(),
    stripeProvider: fakeStripe(),
  });
  const agent = request.agent(app);
  const login = await agent.get('/admin/login');
  await agent
    .post('/admin/login')
    .send({
      email: owner.email,
      password,
      _csrf: login.text.match(/name="_csrf" value="([^"]+)"/)[1],
    })
    .expect(303);
  const page = async (url) => (await agent.get(url).expect(200)).text;
  return { app, agent, repo, service, booking, page };
}
// Adds a copy of the first booking with its own client.
function add(repo, name, values) {
  repo.clients.push({ ...repo.clients[0], name, email: `${name}@x.test` });
  const row = {
    ...structuredClone(repo.rows[0]),
    id: repo.rows.length + 1,
    ref: 'MADO-' + name,
    clientId: repo.clients.length,
    ...values,
  };
  repo.rows.push(row);
  return row;
}
const days = (n) => DateTime.utc().plus({ days: n }).toJSDate();

describe('appointment list', () => {
  it('opens on upcoming visits, nearest first, and sorts each tab correctly', async () => {
    const f = await setup();
    add(f.repo, 'Laterclient', { startAt: days(9) });
    add(f.repo, 'Soonclient', { startAt: days(1.5) });
    add(f.repo, 'Pastclient', { startAt: days(-4), status: 'completed' });
    add(f.repo, 'Goneclient', { startAt: days(2), status: 'cancelled' });
    const list = await f.page('/admin/bookings');
    expect(list.indexOf('Soonclient')).toBeGreaterThan(0);
    expect(list.indexOf('Soonclient')).toBeLessThan(
      list.indexOf('Laterclient'),
    );
    for (const name of ['Pastclient', 'Goneclient'])
      expect(list).not.toContain(name);
    expect(list).toContain('1–3 of 3');

    const past = await f.page('/admin/bookings?view=past');
    expect(past).toContain('Pastclient');
    expect(past).not.toContain('Soonclient');
    const gone = await f.page('/admin/bookings?view=cancelled');
    expect(gone).toContain('Goneclient');
    expect(gone).not.toContain('pay-due">$');
    const all = await f.page('/admin/bookings?view=all');
    expect(all.indexOf('Soonclient')).toBeLessThan(all.indexOf('Pastclient'));
    expect(all).toContain('1–5 of 5');
  });
  it('searches every appointment from the landing page but stays inside a chosen tab', async () => {
    const f = await setup();
    add(f.repo, 'Pastclient', { startAt: days(-4), status: 'completed' });
    expect(await f.page('/admin/bookings?search=Pastclient')).toContain(
      'Pastclient',
    );
    const tab = await f.page('/admin/bookings?view=upcoming&search=Pastclient');
    expect(tab).toContain('Look in all appointments');
    await f.agent.get('/admin/bookings?view=nonsense').expect(400);
  });
  it('lists transfers to review and counts them', async () => {
    const f = await setup();
    expect(await f.page('/admin/bookings?view=review')).toContain(
      'No appointments to show',
    );
    const hold = await f.service.createHold({
      ...validHold,
      email: 'transfer@example.test',
      startAt: DateTime.fromISO(futureStart())
        .plus({ days: 1 })
        .toUTC()
        .toISO(),
    });
    await f.service.submitPaymentProof(hold.id, {
      method: 'zelle',
      path: 'x.webp',
    });
    const review = await f.page('/admin/bookings?view=review');
    expect(review).toContain(`/admin/bookings/${hold.id}#payment-review`);
    expect(review).toContain('is-waiting">1<');
  });
  it('pages 25 at a time and exports the tab on screen', async () => {
    const f = await setup();
    for (let n = 0; n < 30; n++)
      add(f.repo, 'Client' + n, { startAt: days(5 + n) });
    expect(await f.page('/admin/bookings')).toContain('1–25 of 31');
    expect(await f.page('/admin/bookings?page=2')).toContain('26–31 of 31');
    const csv = (await f.agent.get('/admin/bookings/export?view=past')).text;
    expect(csv.trim().split('\n')).toHaveLength(1);
    const every = (await f.agent.get('/admin/bookings/export')).text;
    expect(every.trim().split('\n')).toHaveLength(32);
  });
});

describe('new appointment', () => {
  it('finds existing clients once each, for the owner only', async () => {
    const f = await setup();
    await request(f.app)
      .get('/admin/api/clients?q=test')
      .expect((res) => expect([303, 401]).toContain(res.status));
    f.repo.clients.push({ ...f.repo.clients[0] });
    const { body } = await f.agent
      .get('/admin/api/clients')
      .query({ q: validHold.name.slice(0, 4) })
      .expect(200);
    expect(body.clients).toHaveLength(1);
    expect(Object.keys(body.clients[0]).sort()).toEqual([
      'email',
      'name',
      'phone',
      'phoneLabel',
    ]);
    await f.agent.get('/admin/api/clients?q=a').expect(400);
  });
  it('explains each payment choice and has no developer wording', async () => {
    const f = await setup();
    const text = await f.page('/admin/bookings/new');
    for (const part of [
      'Email a deposit link',
      'Payment already received',
      'No payment yet',
      'data-client-search',
      'data-sum="total"',
    ])
      expect(text).toContain(part);
    for (const url of [
      '/admin/bookings/new',
      '/admin/bookings/1/edit',
      '/admin/bookings/1',
    ])
      expect(await f.page(url)).not.toMatch(/Milestone|Queue /);
  });
});

describe('saving the edit form', () => {
  it.each([
    ['details only', {}],
    [
      'a new style and extras',
      {
        changeStyle: 'on',
        styleId: '1',
        styleVariantId: '101',
        addonIds: ['2'],
      },
    ],
    [
      'a new style without extras',
      { changeStyle: 'on', styleId: '1', styleVariantId: '101' },
    ],
  ])('accepts %s', async (_name, style) => {
    const f = await setup();
    const text = await f.page('/admin/bookings/1/edit');
    const token = text.match(/name="csrf-token" content="([^"]+)"/)[1];
    const local = DateTime.fromJSDate(new Date(f.repo.rows[0].startAt), {
      zone: 'America/New_York',
    });
    const response = await f.agent
      .post('/admin/bookings/1/edit')
      .set('Accept', 'application/json')
      .send({
        _csrf: token,
        name: 'Renamed Client',
        email: 'client@example.test',
        phone: '+14437434979',
        date: local.toISODate(),
        time: local.toFormat('HH:mm'),
        notes: '',
        adminNotes: '',
        expectedUpdatedAt: new Date(f.repo.rows[0].updatedAt).toISOString(),
        requestKey: '6f0e7a52-8d6f-4c3c-9c0c-5b7c8f1b2a3d',
        ...style,
      });
    expect(response.body.message || response.text).toBe('Appointment updated.');
    expect(f.repo.clients[0].name).toBe('Renamed Client');
  });
  it('still needs a style when the style is being changed', async () => {
    const f = await setup();
    const text = await f.page('/admin/bookings/1/edit');
    const response = await f.agent
      .post('/admin/bookings/1/edit')
      .set('Accept', 'application/json')
      .send({
        _csrf: text.match(/name="csrf-token" content="([^"]+)"/)[1],
        name: 'Renamed Client',
        email: 'client@example.test',
        phone: '+14437434979',
        date: '2030-01-07',
        time: '10:00',
        changeStyle: 'on',
        expectedUpdatedAt: new Date().toISOString(),
        requestKey: '6f0e7a52-8d6f-4c3c-9c0c-5b7c8f1b2a3d',
      });
    expect(response.status).toBe(400);
    expect(f.repo.clients[0].name).not.toBe('Renamed Client');
  });
});

describe('appointment details', () => {
  const now = new Date('2026-12-01T15:00:00Z');
  const base = {
    status: 'confirmed',
    startAt: new Date('2026-12-02T15:00:00Z'),
    balanceCents: 15000,
  };
  const can = (booking, rest = {}) =>
    appointmentActions({ booking: { ...base, ...booking }, now, ...rest });
  it('offers only actions that can succeed', () => {
    expect(can({})).toMatchObject({
      edit: true,
      cancel: true,
      payment: true,
      balanceLink: true,
      resend: true,
      complete: false,
      noShow: false,
      confirm: false,
    });
    expect(can({ startAt: new Date('2026-12-01T14:00:00Z') })).toMatchObject({
      complete: true,
      noShow: true,
    });
    expect(can({ status: 'cancelled' })).toMatchObject({
      payment: false,
      cancel: false,
      edit: false,
      balanceLink: false,
      resend: false,
    });
    expect(can({ balanceCents: 0 })).toMatchObject({
      payment: false,
      balanceLink: false,
    });
    const held = { status: 'pending_payment' };
    expect(
      can({ ...held, holdExpiresAt: new Date(+now + 60000) }),
    ).toMatchObject({ confirm: true, payment: true, holdLive: true });
    expect(can({ ...held, holdExpiresAt: new Date(+now - 1) })).toMatchObject({
      confirm: false,
      payment: false,
      edit: false,
      cancel: true,
    });
  });
  it('locks changes during a review, an open card payment or a refund', () => {
    for (const rest of [
      { proofs: [{ status: 'pending' }] },
      { attempts: [{ status: 'open' }] },
      { refundJobs: [{ status: 'pending' }] },
    ]) {
      const actions = can({}, rest);
      expect(actions.blocked).toBeTruthy();
      expect(actions).toMatchObject({
        cancel: false,
        payment: false,
        edit: false,
      });
    }
  });
  it('offers only what is left of each payment to refund', () => {
    const payments = [
      { id: 1, type: 'deposit', provider: 'manual', amountCents: 3000 },
      {
        id: 2,
        type: 'refund',
        provider: 'manual',
        amountCents: 1000,
        note: 'Refund of payment 1. Agreed',
      },
    ];
    expect(can({}, { payments }).refundable[0].remainingCents).toBe(2000);
    payments[1].amountCents = 3000;
    expect(can({}, { payments }).refundable).toEqual([]);
  });
  it('tells one readable story, newest first', () => {
    const history = appointmentHistory({
      booking: { createdAt: new Date(1000), source: 'web' },
      payments: [
        {
          createdAt: new Date(2000),
          type: 'deposit',
          method: 'zelle',
          amountCents: 3000,
        },
      ],
      audits: [
        {
          createdAt: new Date(3000),
          action: 'no-show',
          adminId: 4,
          changes: [
            { label: 'Reason / note', before: '—', after: 'Did not call' },
          ],
        },
      ],
      emails: [
        {
          createdAt: new Date(4000),
          template: 'booking-confirmation',
          status: 'delivered',
        },
      ],
      adminName: () => 'Magdaline',
      money: (cents) => '$' + cents / 100,
    });
    expect(history.map((item) => [item.title, item.by])).toEqual([
      ['Email: Booking confirmation', 'Delivered'],
      ['Marked no-show', 'Magdaline'],
      ['Deposit payment of $30', 'Zelle'],
      ['Booked on the website', undefined],
    ]);
    expect(history[1].changes[0].after).toBe('Did not call');
  });
  it('shows confirmation windows, contact buttons and a prefilled balance', async () => {
    const f = await setup();
    const text = await f.page('/admin/bookings/1');
    for (const part of [
      'id="action-cancel"',
      'id="action-payment"',
      'https://wa.me/1',
      'href="tel:',
      'data-copy-text="https://www.google.com/maps',
      'data-live="appointment-version" data-live-reload',
      'appear once the visit has started',
      'Studio Owner',
      'No completed visits yet',
    ])
      expect(text).toContain(part);
    const balance = (f.repo.rows[0].balanceCents / 100).toFixed(2);
    expect(text).toContain(`value="${balance}"`);
    expect(text).not.toContain('id="action-complete"');
    expect(text).not.toContain('Owner 1');

    const version = () =>
      f
        .page('/admin/bookings/1')
        .then((html) => html.match(/data-live-reload>([a-f0-9]+)</)[1]);
    const before = await version();
    expect(await version()).toBe(before);
    f.repo.rows[0].paidCents = 3000;
    expect(await version()).not.toBe(before);
  });
});
