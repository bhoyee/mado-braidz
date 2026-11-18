import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import {
  createNotificationService,
  reminderTimes,
  marketingEligible,
} from '../src/services/notificationService.js';
import {
  createEmailService,
  renderEmail,
  unsubscribeToken,
  validUnsubscribe,
} from '../src/services/emailService.js';
import { accessToken, tokenHash } from '../src/services/bookingService.js';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig } from './fixtures/stripe.js';
export function notificationFixture() {
  const now = new Date('2026-11-18T12:00:00Z');
  const config = parseEnv({
    ...paymentConfig,
    EMAIL_ENABLED: 'true',
    EMAIL_PROVIDER: 'log',
    ADMIN_EMAIL: 'owner@example.test',
  });
  const client = {
    id: 1,
    name: 'A Client',
    email: 'client@example.test',
    marketingConsent: true,
    unsubscribedAt: null,
  };
  const booking = {
    id: 1,
    clientId: 1,
    ref: 'MB-TEST42',
    styleId: 1,
    status: 'confirmed',
    createdAt: new Date('2026-11-01T12:00:00Z'),
    updatedAt: now,
    startAt: new Date('2026-11-20T15:00:00Z'),
    endAt: new Date('2026-11-20T19:00:00Z'),
    paidCents: 3000,
    balanceCents: 9000,
    manageTokenHash: tokenHash(accessToken('MB-TEST42', config.SESSION_SECRET)),
    priceSnapshot: { styleName: 'Men’s Invisible Locs', durationMin: 240 },
  };
  const state = {
    bookings: [booking],
    clients: [client],
    notifications: [],
    styles: [{ id: 1, slug: 'mens-invisible-locs' }],
    settings: {
      business: {
        name: 'Mado',
        street: '7375 Executive Place',
        city: 'Lanham',
        region: 'MD',
        postalCode: '20706',
      },
      emails: { reminderHours: 48, morningReminder: true, winback: true },
    },
  };
  const jobs = [],
    logs = [],
    markers = new Set();
  const repo = {
    context: async () => state,
    detail: async (id) => {
      const booking = state.bookings.find((b) => b.id === id);
      return booking
        ? {
            booking,
            client: state.clients.find((c) => c.id === booking.clientId),
          }
        : null;
    },
    client: async (id) => state.clients.find((c) => c.id === id),
    queue: async (values) => {
      const old = jobs.find((j) => j.dedupeKey === values.dedupeKey);
      if (!old)
        jobs.push({
          id: jobs.length + 1,
          attempts: 0,
          createdAt: now,
          ...values,
        });
    },
    pending: async () =>
      jobs.filter(
        (j) =>
          ['reminder', 'winback'].includes(j.type) &&
          ['pending', 'failed'].includes(j.status),
      ),
    due: async (date, cutoff) =>
      jobs.filter(
        (j) =>
          j.runAt <= date &&
          j.createdAt >= cutoff &&
          ['pending', 'failed'].includes(j.status) &&
          j.attempts < 5,
      ),
    saveJob: async (id, patch) =>
      Object.assign(
        jobs.find((j) => j.id === id),
        patch,
      ),
    log: async (key) => logs.find((l) => l.deliveryKey === key),
    reserveLog: async (values) => {
      const row = { id: logs.length + 1, ...values };
      logs.push(row);
      return row;
    },
    saveLog: async (id, patch) =>
      Object.assign(
        logs.find((l) => l.id === id),
        patch,
      ),
    suppressed: async () => false,
    notify: async (values) =>
      state.notifications.push({
        id: state.notifications.length + 1,
        createdAt: now,
        ...values,
      }),
    notifyOnce: async (key, values) => {
      if (!markers.has(key)) {
        markers.add(key);
        await repo.notify(values);
      }
    },
    lifecycleJobs: async () => jobs.filter((j) => j.type === 'email'),
    subscriptions: async () => [],
    notification: async (id) => state.notifications.find((n) => n.id === id),
    cleanup: async () => {},
    failedJobs: async () => [],
    unsubscribe: async (id) => {
      const c = await repo.client(id);
      c.marketingConsent = false;
      c.unsubscribedAt = now;
      for (const j of jobs)
        if (j.type === 'winback' && j.payload.clientId === id)
          j.status = 'cancelled';
    },
    delivery: vi.fn(),
    notifications: async () => ({ items: [], unread: 0 }),
  };
  const email = { send: vi.fn(async () => `message-${logs.length}`) };
  const service = createNotificationService(repo, config, {
    clock: () => now,
    email,
  });
  return {
    now,
    config,
    client,
    booking,
    state,
    jobs,
    logs,
    repo,
    email,
    service,
  };
}
describe('Milestone 7 scheduling', () => {
  it.each(['2026-03-08T10:00:00', '2026-11-01T10:00:00'])(
    'uses Eastern local morning through DST at %s',
    (iso) => {
      const start = DateTime.fromISO(iso, { zone: 'America/New_York' });
      const times = reminderTimes({ startAt: start.toJSDate() });
      expect(
        DateTime.fromJSDate(times.morning, {
          zone: 'America/New_York',
        }).toFormat('yyyy-MM-dd HH:mm'),
      ).toBe(start.toISODate() + ' 07:00');
      expect(+start - +times.first).toBe(48 * 3600000);
    },
  );
  it('sends early-appointment reminders before a 6am visit', () => {
    const times = reminderTimes({ startAt: new Date('2026-11-20T11:00:00Z') });
    expect(times.morning.toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });
  it('schedules reminders once and cancels old times after a reschedule', async () => {
    const f = notificationFixture();
    await f.service.schedule();
    await f.service.schedule();
    expect(f.jobs.filter((j) => j.type === 'reminder')).toHaveLength(2);
    f.booking.startAt = new Date('2026-11-21T15:00:00Z');
    await f.service.schedule();
    expect(
      f.jobs.filter((j) => j.type === 'reminder' && j.status === 'cancelled'),
    ).toHaveLength(2);
    expect(
      f.jobs.filter((j) => j.type === 'reminder' && j.status === 'pending'),
    ).toHaveLength(2);
  });
  it('cancels reminders for cancelled bookings and never sends stale confirmations', async () => {
    const f = notificationFixture();
    await f.service.schedule();
    await f.repo.queue({
      type: 'email',
      payload: { bookingId: 1, template: 'booking-confirmation' },
      dedupeKey: 'confirmation',
      runAt: f.now,
      status: 'pending',
    });
    f.booking.status = 'cancelled';
    await f.service.run();
    expect(
      f.jobs
        .filter((j) => j.type === 'reminder')
        .every((j) => j.status === 'cancelled'),
    ).toBe(true);
    expect(f.logs.some((l) => l.template === 'booking-confirmation')).toBe(
      false,
    );
  });
  it('schedules thank-you and 30/60/90-day winbacks; a new booking cancels them', async () => {
    const f = notificationFixture();
    f.booking.status = 'completed';
    f.booking.completedAt = new Date('2026-11-17T16:00:00Z');
    await f.service.schedule();
    expect(f.jobs.filter((j) => j.type === 'winback')).toHaveLength(3);
    expect(
      f.jobs
        .find((j) => j.payload.template === 'thank-you')
        .runAt.toISOString(),
    ).toBe('2026-11-17T19:00:00.000Z');
    f.state.bookings.push({
      ...f.booking,
      id: 2,
      status: 'confirmed',
      startAt: new Date('2026-12-01T15:00:00Z'),
      completedAt: null,
    });
    await f.service.schedule();
    expect(
      f.jobs
        .filter((j) => j.type === 'winback')
        .every((j) => j.status === 'cancelled'),
    ).toBe(true);
  });
  it('requires consent and honours unsubscribe before scheduling and sending', async () => {
    const f = notificationFixture();
    f.booking.status = 'completed';
    f.booking.completedAt = f.now;
    f.client.marketingConsent = false;
    await f.service.schedule();
    expect(f.jobs.filter((j) => j.type === 'winback')).toHaveLength(0);
    expect(
      marketingEligible(f.booking, f.client, f.state.bookings, f.now),
    ).toBe(false);
    f.client.marketingConsent = true;
    await f.service.schedule();
    const token = unsubscribeToken(f.client, f.config.SESSION_SECRET);
    expect(await f.service.unsubscribe(token)).toBe(true);
    expect(
      f.jobs
        .filter((j) => j.type === 'winback')
        .every((j) => j.status === 'cancelled'),
    ).toBe(true);
    expect(await f.service.unsubscribe(token + 'x')).toBe(false);
  });
  it('sends due email once across cron runs and logs the provider id', async () => {
    const f = notificationFixture();
    await f.repo.queue({
      type: 'email',
      payload: { bookingId: 1, template: 'booking-confirmation' },
      dedupeKey: 'confirmation',
      runAt: f.now,
      status: 'pending',
    });
    await f.service.run();
    await f.service.run();
    expect(
      f.logs.filter((l) => l.template === 'booking-confirmation'),
    ).toHaveLength(1);
    expect(
      f.logs.find((l) => l.template === 'booking-confirmation').providerId,
    ).toMatch(/^message-/);
  });
  it('backs off failures and holds uncertain results for owner review instead of duplicating', async () => {
    const f = notificationFixture();
    f.state.bookings = [];
    f.state.settings.emails.adminAlertEmails = ['owner@example.test'];
    f.email.send.mockRejectedValue(
      Object.assign(new Error('timeout'), { uncertain: true }),
    );
    await f.repo.queue({
      type: 'email',
      payload: { template: 'owner-test', to: 'owner@example.test' },
      dedupeKey: 'test',
      runAt: f.now,
      status: 'pending',
    });
    await f.service.run();
    expect(f.jobs[0].attempts).toBe(5);
    expect(f.logs[0].status).toBe('unknown');
    await f.service.run();
    expect(
      f.email.send.mock.calls.filter((call) => call[2].startsWith('job:1:')),
    ).toHaveLength(1);
  });
  it('keeps pre-activation queued client emails out of a production launch', async () => {
    const f = notificationFixture();
    f.config.NOTIFICATIONS_START_AT = '2026-11-18T12:00:00.000Z';
    await f.repo.queue({
      type: 'email',
      payload: { bookingId: 1, template: 'booking-confirmation' },
      dedupeKey: 'old',
      runAt: f.now,
      createdAt: new Date('2026-11-17T00:00:00Z'),
      status: 'pending',
    });
    await f.service.run();
    expect(f.logs.some((l) => l.template === 'booking-confirmation')).toBe(
      false,
    );
  });
});
describe('Brevo content and security', () => {
  it('renders escaped booking details, valid UTC calendar attachment and manage link', async () => {
    const f = notificationFixture();
    f.client.name = '<script>alert(1)</script>';
    const message = await renderEmail(
      f.config,
      { template: 'booking-confirmation' },
      { booking: f.booking, client: f.client },
      f.state.settings,
    );
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).not.toContain('<script>');
    expect(message.text).toContain(
      '/booking/' + accessToken(f.booking.ref, f.config.SESSION_SECRET),
    );
    expect(
      Buffer.from(message.attachments[0].Content, 'base64').toString(),
    ).toContain('DTSTART:20261120T150000Z');
  });
  it('tags consent-based marketing and includes signed unsubscribe links', async () => {
    const f = notificationFixture();
    const message = await renderEmail(
      f.config,
      { template: 'winback-30' },
      { booking: f.booking, client: f.client },
      f.state.settings,
    );
    expect(message.marketing).toBe(true);
    expect(
      message.headers.find((h) => h.Name === 'List-Unsubscribe-Post').Value,
    ).toBe('List-Unsubscribe=One-Click');
    expect(
      validUnsubscribe(
        unsubscribeToken(f.client, f.config.SESSION_SECRET),
        f.client,
        f.config.SESSION_SECRET,
      ),
    ).toBe(true);
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messageId: '<brevo-test>' }),
    }));
    const sender = createEmailService(
      {
        ...f.config,
        EMAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'test-token',
      },
      fetcher,
    );
    await sender.send(f.client.email, message, 'test-delivery');
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.tags).toContain('mado-return-visit');
    expect(body).not.toHaveProperty('attachment');
    expect(body.sender.email).toBe('bookings@madoafricanbraidz.com');
    expect(body.headers['X-Mailin-custom']).toBe('deliveryKey:test-delivery');
  });
  it('protects delivery webhooks and supports signed one-click unsubscribe without a session', async () => {
    const f = notificationFixture();
    f.config.BREVO_WEBHOOK_SECRET = 'test-webhook-secret';
    const app = createApp({
      config: f.config,
      catalog: fixtureCatalog(),
      notificationService: f.service,
    });
    await request(app)
      .post('/webhooks/brevo')
      .send({
        event: 'delivered',
        'message-id': 'test',
        email: f.client.email,
      })
      .expect(401);
    await request(app)
      .post('/webhooks/brevo')
      .set('X-Mado-Webhook-Secret', 'test-webhook-secret')
      .send({
        event: 'delivered',
        'message-id': 'test',
        email: f.client.email,
      })
      .expect(200);
    expect(f.repo.delivery).toHaveBeenCalledTimes(1);
    await request(app)
      .post('/webhooks/brevo')
      .set('X-Mado-Webhook-Secret', 'test-webhook-secret')
      .send({
        event: 'blocked',
        'message-id': 'blocked-test',
        email: f.client.email,
      })
      .expect(200);
    expect(f.repo.delivery).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'blocked', suppress: false }),
    );
    const token = unsubscribeToken(f.client, f.config.SESSION_SECRET);
    await request(app)
      .get('/unsubscribe/' + token)
      .expect(200);
    expect(f.client.marketingConsent).toBe(true);
    await request(app)
      .post('/unsubscribe/' + token)
      .type('form')
      .send({ 'List-Unsubscribe': 'One-Click' })
      .expect(200);
    expect(f.client.marketingConsent).toBe(false);
  });
});
