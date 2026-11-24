import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import {
  alertPreferences,
  alertText,
  deviceName,
  emailAllowed,
  quietUntil,
} from '../src/services/alerts.js';
import { createNotificationService } from '../src/services/notificationService.js';
import { instantAlerts } from '../src/middleware/instantAlerts.js';
import { ownerAppFiles } from '../src/routes/admin/notifications.js';
import { notificationFixture } from './notifications.test.js';

const detail = {
  booking: {
    paidCents: 3000,
    startAt: new Date('2026-11-28T15:00:00Z'),
    priceSnapshot: { styleName: 'Knotless Braids' },
  },
  client: { name: 'Aisha Bello' },
};
describe('alert wording', () => {
  it('says who booked what, when and how much', () => {
    const text = alertText(
      { type: 'booking_confirmed', title: 'A chair is booked', body: 'MADO-1' },
      detail,
    );
    expect(text.title).toBe('Aisha Bello booked Knotless Braids');
    expect(text.body).toBe('Sat, Nov 28 at 10:00 AM · $30 paid');
  });
  it('keeps the client name off device alerts unless chosen', () => {
    for (const type of [
      'booking_confirmed',
      'payment_review',
      'refund_issued',
      'booking_cancelled',
    ]) {
      const text = alertText(
        { type, title: 'x', body: 'MADO-1: zelle payment submitted.' },
        detail,
        { names: false },
      );
      expect(text.title + text.body).not.toContain('Aisha');
    }
  });
  it('never names an unknown device or repeats a job number', () => {
    expect(
      alertText({ type: 'email_failure', title: 'x', body: 'Job 12: check' })
        .body,
    ).not.toContain('12');
    expect(deviceName('Mozilla/5.0 (iPhone) Safari/604')).toBe(
      'iPhone · Safari',
    );
    expect(
      deviceName('Mozilla/5.0 (Windows NT 10.0) Chrome/140 Safari Edg/140'),
    ).toBe('Windows computer · Edge');
  });
});
describe('alert choices', () => {
  it('always keeps payments to review on', () => {
    const prefs = alertPreferences(
      { email: { review: false }, owners: { 1: { push: { review: false } } } },
      1,
    );
    expect(prefs.email.review).toBe(true);
    expect(prefs.push.review).toBe(true);
  });
  it('keeps today’s email behaviour until it is changed', () => {
    expect(emailAllowed(undefined, 'booking_confirmed')).toBe(true);
    expect(emailAllowed(undefined, 'balance_paid')).toBe(false);
    expect(
      emailAllowed({ email: { bookings: false } }, 'booking_confirmed'),
    ).toBe(false);
  });
  it('handles quiet hours across midnight', () => {
    const prefs = { quiet: true, quietFrom: '22:00', quietTo: '07:00' };
    // 11 PM and 3 AM Eastern both end at 7 AM Eastern the same morning.
    for (const at of ['2026-11-25T04:00:00Z', '2026-11-25T08:00:00Z'])
      expect(quietUntil(prefs, new Date(at)).toISOString()).toBe(
        '2026-11-25T12:00:00.000Z',
      );
    expect(quietUntil(prefs, new Date('2026-11-25T12:00:00Z'))).toBe(null);
    expect(
      quietUntil({ ...prefs, quiet: false }, new Date('2026-11-25T04:00:00Z')),
    ).toBe(null);
  });
});
describe('device alerts', () => {
  function setup(type = 'booking_confirmed', alerts) {
    const f = notificationFixture();
    const subs = [1, 2].map((id) => ({
      id,
      adminId: id,
      endpoint: 'https://fcm.googleapis.com/' + id,
      keys: {},
    }));
    f.repo.subscriptions = async () => subs;
    f.repo.deleteSubscription = vi.fn();
    f.state.settings.alerts = alerts;
    f.state.notifications.push({
      id: 1,
      type,
      title: 't',
      body: 'b',
      url: '/admin/bookings/1',
      createdAt: f.now,
    });
    f.jobs.push({
      id: 1,
      type: 'push',
      status: 'pending',
      attempts: 0,
      runAt: f.now,
      createdAt: f.now,
      payload: { template: 'push', notificationId: 1 },
    });
    const push = { sendNotification: vi.fn(async () => {}) };
    const service = createNotificationService(
      f.repo,
      { ...f.config, VAPID_PUBLIC_KEY: 'a', VAPID_PRIVATE_KEY: 'b' },
      { push, clock: () => f.now, email: f.email },
    );
    return { ...f, push, service };
  }
  it('does not repeat an alert on devices that already received it', async () => {
    const f = setup();
    f.push.sendNotification.mockImplementation(async (sub) => {
      if (sub.endpoint.endsWith('2')) throw new Error('down');
    });
    await f.service.deliver();
    expect(f.jobs[0].status).toBe('failed');
    f.jobs[0].runAt = f.now;
    f.push.sendNotification.mockClear();
    f.push.sendNotification.mockImplementation(async () => {});
    await f.service.deliver();
    expect(f.push.sendNotification).toHaveBeenCalledTimes(1);
    expect(f.push.sendNotification.mock.calls[0][0].endpoint).toMatch(/2$/);
    expect(f.jobs[0].status).toBe('done');
  });
  // The fixture clock is 7 AM Eastern.
  const quiet = {
    owners: { 1: { quiet: true, quietFrom: '06:00', quietTo: '08:00' } },
  };
  it('holds an owner’s alert through quiet hours, without delaying others', async () => {
    const f = setup('booking_confirmed', quiet);
    await f.service.deliver();
    expect(f.push.sendNotification).toHaveBeenCalledTimes(1);
    expect(f.jobs[0]).toMatchObject({ status: 'pending' });
    expect(f.jobs[0].runAt.toISOString()).toBe('2026-11-18T13:00:00.000Z');
  });
  it('sends payments to review even in quiet hours', async () => {
    const f = setup('payment_review', quiet);
    await f.service.deliver();
    expect(f.push.sendNotification).toHaveBeenCalledTimes(2);
  });
  it('respects a switched-off group and an alert already read', async () => {
    const f = setup('booking_confirmed', {
      owners: { 1: { push: { bookings: false } } },
    });
    f.repo.readers = async () => new Set([2]);
    await f.service.deliver();
    expect(f.push.sendNotification).not.toHaveBeenCalled();
    expect(f.jobs[0].status).toBe('done');
  });
  it('sends alerts right away only with the shared lock, and never client emails', async () => {
    const f = setup();
    f.jobs.push({
      ...f.jobs[0],
      id: 2,
      type: 'email',
      payload: { template: 'booking-confirmation', bookingId: 1 },
    });
    f.repo.recentNotifications = async () => f.state.notifications;
    f.repo.withLock = async () => false;
    expect(await f.service.deliverAlerts()).toBe(false);
    expect(f.push.sendNotification).not.toHaveBeenCalled();
    f.repo.withLock = async (fn) => (await fn(), true);
    expect(await f.service.deliverAlerts()).toBe(true);
    expect(f.push.sendNotification).toHaveBeenCalled();
    expect(f.jobs[1].status).toBe('pending');
  });
});
describe('instant alerts', () => {
  it('follows successful changes only and never breaks the request', async () => {
    const service = {
      deliverAlerts: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const app = express();
    app.use(instantAlerts(service, () => {}, 5));
    app.post('/ok', (_req, res) => res.sendStatus(200));
    app.post('/bad', (_req, res) => res.sendStatus(400));
    app.get('/ok', (_req, res) => res.sendStatus(200));
    const settle = () => new Promise((done) => setTimeout(done, 60));
    await request(app).get('/ok');
    await request(app).post('/bad');
    await settle();
    expect(service.deliverAlerts).not.toHaveBeenCalled();
    await request(app).post('/ok').expect(200);
    await settle();
    expect(service.deliverAlerts).toHaveBeenCalledTimes(1);
  });
});
describe('phone app files', () => {
  it('load without signing in and hold nothing private', async () => {
    const app = express().use('/admin', ownerAppFiles());
    const manifest = await request(app)
      .get('/admin/manifest.webmanifest')
      .expect(200);
    expect(JSON.parse(manifest.text ?? manifest.body)).toMatchObject({
      display: 'standalone',
      scope: '/admin/',
    });
    const worker = await request(app).get('/admin/sw.js').expect(200);
    expect(worker.headers['content-type']).toContain('javascript');
  });
});
