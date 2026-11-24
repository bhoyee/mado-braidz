import { describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createBookingService } from '../src/services/bookingService.js';
import { showOnCalendar } from '../src/services/adminCalendar.js';
import { memoryBookingRepository, validHold } from './fixtures/booking.js';
import { memoryAdminRepository, futureStart } from './fixtures/admin.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig, fakeStripe } from './fixtures/stripe.js';

const config = parseEnv({ ...paymentConfig, UPLOAD_DIR: 'tmp/test-calendar' });
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
  const booking = await service.createHold({
    ...validHold,
    startAt: futureStart(),
  });
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
  const start = DateTime.utc().minus({ days: 1 }).toISO();
  const end = DateTime.utc().plus({ days: 10 }).toISO();
  const feed = async () =>
    (await agent.get('/admin/api/calendar').query({ start, end }).expect(200))
      .body;
  return { app, agent, repo, service, booking, feed, start, end };
}

describe('owner calendar', () => {
  it('needs a signed-in owner', async () => {
    const { app, start, end } = await setup();
    const response = await request(app)
      .get('/admin/api/calendar')
      .query({ start, end });
    expect([303, 401]).toContain(response.status);
  });
  it('gives the details the owner needs and marks a transfer to review', async () => {
    const f = await setup();
    let [event] = await f.feed();
    expect(event.classNames).toEqual(['status-pending_payment']);
    expect(event.extendedProps).toMatchObject({
      name: validHold.name,
      statusLabel: 'Awaiting payment',
      review: false,
      paid: '$0.00',
      open: true,
      owes: true,
    });
    expect(event.extendedProps.phoneLabel).toMatch(/^\(\d{3}\) /);
    expect(event.extendedProps.when).toMatch(/10:00 AM – .* ET$/);

    const proof = await f.service.submitPaymentProof(f.booking.id, {
      method: 'zelle',
      path: 'private.webp',
    });
    [event] = await f.feed();
    expect(event.classNames).toEqual(['status-review']);
    expect(event.extendedProps).toMatchObject({
      statusLabel: 'Payment to review',
      review: true,
      source: 'Zelle',
    });
    expect(JSON.stringify(event)).not.toContain('private.webp');

    await f.service.reviewPaymentProof(proof.id, 'approve', owner);
    [event] = await f.feed();
    expect(event.classNames).toEqual(['status-confirmed']);
    expect(event.extendedProps).toMatchObject({
      statusLabel: 'Confirmed',
      review: false,
      paid: '$30.00',
    });
  });
  it('drops ended holds but keeps one whose transfer is still unreviewed', () => {
    const now = new Date();
    const row = {
      booking: { status: 'pending_payment', holdExpiresAt: new Date(+now - 1) },
      paymentReview: false,
    };
    expect(showOnCalendar(row, now)).toBe(false);
    expect(showOnCalendar({ ...row, paymentReview: true }, now)).toBe(true);
  });
  it('shows blocked time and keeps it apart from appointments', async () => {
    const f = await setup();
    const startAt = DateTime.utc().plus({ days: 4 }).toJSDate();
    f.repo.timeBlocks.push({
      id: 9,
      startAt,
      endAt: new Date(+startAt + 3600000),
      reason: 'Family day',
    });
    const block = (await f.feed()).find((e) => e.extendedProps.block);
    expect(block).toMatchObject({
      id: 'block-9',
      title: 'Blocked · Family day',
      editable: false,
      classNames: ['calendar-block'],
    });
    expect(block.url).toBeUndefined();
  });
  it('renders opening hours, a matching key and the details window', async () => {
    const f = await setup();
    const { text } = await f.agent.get('/admin/calendar').expect(200);
    const hours = text
      .match(/data-hours="([^"]+)"/)[1]
      .replaceAll('&quot;', '"');
    expect(JSON.parse(hours).sunday).toMatchObject({
      open: '10:00',
      close: '18:00',
    });
    for (const part of [
      'status-review',
      'data-show-cancelled',
      'data-calendar-status',
      'id="calendar-details"',
    ])
      expect(text).toContain(part);
  });
});
