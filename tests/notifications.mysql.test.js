import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createNotificationService } from '../src/services/notificationService.js';
import { parseEnv } from '../src/config/env.js';
import { paymentConfig } from './fixtures/stripe.js';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/index.js';
import { createNotificationRepository } from '../src/services/notificationRepository.js';
import * as s from '../src/db/schema.js';
describe.skipIf(process.env.BOOKING_DATABASE_TEST !== '1')(
  'notification delivery with real MySQL',
  () => {
    let admin, pool, db, repo;
    const name = 'mado_notifications_test_' + randomBytes(6).toString('hex');
    beforeAll(async () => {
      const url = new URL(
        process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      );
      admin = await mysql.createConnection(url.toString());
      await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
      url.pathname = '/' + name;
      ({ db, pool } = createDatabase(url.toString()));
      await migrate(db, { migrationsFolder: 'src/db/migrations' });
      repo = createNotificationRepository(db);
      await db.insert(s.clients).values({
        id: 1,
        name: 'Test Client',
        email: 'client@example.test',
        phoneE164: '+14437434979',
        marketingConsent: true,
        createdAt: new Date(),
      });
      await db.insert(s.admins).values({
        id: 1,
        name: 'Owner',
        email: 'owner@example.test',
        passwordHash: 'unused',
        role: 'owner',
      });
    }, 30000);
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
        await admin.end();
      }
    });
    it('reserves only one log per delivery key', async () => {
      const input = {
        deliveryKey: 'job:1:client@example.test',
        clientId: 1,
        toEmail: 'client@example.test',
        template: 'booking-confirmation',
        status: 'sending',
      };
      const a = await repo.reserveLog(input),
        b = await repo.reserveLog(input);
      expect(a.id).toBe(b.id);
      await repo.saveLog(a.id, { providerId: 'brevo-one', status: 'sent' });
    });
    it('counts only earlier completed visits for the WhatsApp returning-client label', async () => {
      await db
        .insert(s.styleCategories)
        .values({ id: 90, name: 'Test', slug: 'whatsapp-visits-test' });
      await db
        .insert(s.styles)
        .values({
          id: 90,
          categoryId: 90,
          name: 'Knotless Braids',
          slug: 'whatsapp-visits-test',
          durationMin: 240,
          updatedAt: new Date(),
        });
      const start = new Date('2026-12-07T17:00:00Z');
      const base = {
        clientId: 1,
        styleId: 90,
        startAt: new Date('2026-12-01T15:00:00Z'),
        endAt: new Date('2026-12-01T19:00:00Z'),
        blockEndAt: new Date('2026-12-01T19:30:00Z'),
        paymentStatus: 'paid_in_full',
        paymentChoice: 'full',
        source: 'web',
        priceSnapshot: { styleName: 'Knotless Braids' },
        subtotalCents: 18000,
        depositCents: 3000,
        manageTokenHash: 'test-only',
        updatedAt: new Date(),
      };
      await db.insert(s.bookings).values([
        { ...base, id: 90, ref: 'VISIT-DONE', status: 'completed' },
        { ...base, id: 91, ref: 'VISIT-CANCELLED', status: 'cancelled' },
        { ...base, id: 92, ref: 'VISIT-NOSHOW', status: 'no_show' },
        {
          ...base,
          id: 93,
          ref: 'VISIT-LATER',
          status: 'completed',
          startAt: new Date('2026-12-10T15:00:00Z'),
          endAt: new Date('2026-12-10T19:00:00Z'),
          blockEndAt: new Date('2026-12-10T19:30:00Z'),
        },
      ]);
      expect(
        await repo.completedVisitsBefore({
          id: 95,
          clientId: 1,
          startAt: start,
        }),
      ).toBe(1);
    });
    it('keeps future reminders eligible across activation without releasing old confirmations', async () => {
      const now = new Date(),
        cutoff = new Date(+now - 60000),
        createdAt = new Date(+now - 86400000);
      await repo.queue({
        type: 'reminder',
        payload: {},
        dedupeKey: 'activation-reminder',
        runAt: now,
        createdAt,
        status: 'pending',
      });
      await repo.queue({
        type: 'email',
        payload: { template: 'booking-confirmation' },
        dedupeKey: 'activation-old-confirmation',
        runAt: now,
        createdAt,
        status: 'pending',
      });
      const due = await repo.due(now, cutoff);
      expect(due.some((j) => j.dedupeKey === 'activation-reminder')).toBe(true);
      expect(
        due.some((j) => j.dedupeKey === 'activation-old-confirmation'),
      ).toBe(false);
    });
    it('handles out-of-order and replayed callbacks without downgrading a complaint', async () => {
      const event = {
        providerId: 'brevo-one',
        recipient: 'client@example.test',
      };
      await repo.delivery({ ...event, kind: 'delivered' });
      await repo.delivery({ ...event, kind: 'complained', suppress: true });
      await repo.delivery({ ...event, kind: 'delivered' });
      await repo.delivery({ ...event, kind: 'complained', suppress: true });
      expect((await repo.log('job:1:client@example.test')).status).toBe(
        'complained',
      );
      expect(await repo.suppressed('client@example.test')).toBeTruthy();
      expect((await repo.client(1)).marketingConsent).toBe(false);
    });
    it('ignores a callback whose recipient does not match its message', async () => {
      await repo.delivery({
        providerId: 'brevo-one',
        recipient: 'other@example.test',
        kind: 'bounced',
        suppress: true,
      });
      expect(await repo.suppressed('other@example.test')).toBeFalsy();
    });
    it('cancels durable marketing jobs on unsubscribe', async () => {
      await repo.queue({
        type: 'winback',
        payload: { clientId: 1, template: 'winback-30' },
        dedupeKey: 'winback-test',
        runAt: new Date(),
        status: 'pending',
      });
      await repo.unsubscribe(1);
      const [job] = await db
        .select()
        .from(s.jobs)
        .where(eq(s.jobs.dedupeKey, 'winback-test'));
      expect(job.status).toBe('cancelled');
      expect((await repo.client(1)).unsubscribedAt).toBeTruthy();
    });
    it('creates an owner notification once and keeps read state', async () => {
      const values = {
        type: 'booking_confirmed',
        title: 'A chair is booked',
        body: 'Test',
        url: '/admin/bookings/1',
      };
      await repo.notifyOnce('test-booking', values);
      await repo.notifyOnce('test-booking', values);
      const result = await repo.notifications(1);
      expect(result.items).toHaveLength(1);
      expect(result.unread).toBe(1);
      await repo.markRead(1, result.items[0].id);
      expect((await repo.notifications(1)).unread).toBe(0);
    });
    it('cannot transfer or remove another owner’s push subscription', async () => {
      await db.insert(s.admins).values({
        id: 2,
        name: 'Other',
        email: 'other@example.test',
        passwordHash: 'unused',
        role: 'owner',
      });
      const input = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/test',
        keys: { p256dh: 'key', auth: 'auth' },
      };
      await repo.saveSubscription(1, input);
      await expect(repo.saveSubscription(2, input)).rejects.toThrow();
      await repo.deleteSubscription(input.endpoint, 2);
      expect(await repo.subscriptions(1)).toHaveLength(1);
    });
    it('persists the sending state before a WhatsApp request and completes it without duplicate sends', async () => {
      await repo.notify({
        type: 'booking_confirmed',
        title: 'Database delivery test',
        body: 'No real message',
        url: '/admin/notifications',
      });
      const [notification] = await db
        .select()
        .from(s.notifications)
        .where(eq(s.notifications.title, 'Database delivery test'));
      await repo.queue({
        type: 'whatsapp',
        payload: {
          template: 'owner-whatsapp',
          notificationId: notification.id,
        },
        dedupeKey: 'database-whatsapp-test',
        status: 'pending',
        runAt: new Date(),
      });
      const config = parseEnv({
        ...paymentConfig,
        EMAIL_ENABLED: 'false',
        WHATSAPP_PROVIDER: 'callmebot',
        WHATSAPP_OWNER_NUMBER: '+14437434979',
        CALLMEBOT_API_KEY: 'test-only',
        WHATSAPP_ALERTS_ENABLED: 'true',
        WHATSAPP_ALERTS_START_AT: new Date(Date.now() - 60000).toISOString(),
      });
      const whatsapp = {
        sendOwnerAlert: vi.fn(async () => {
          const [job] = await db
            .select()
            .from(s.jobs)
            .where(eq(s.jobs.dedupeKey, 'database-whatsapp-test'));
          expect(job.status).toBe('sending');
          return 'callmebot:accepted';
        }),
      };
      const service = createNotificationService(repo, config, { whatsapp });
      service.schedule = async () => {};
      await service.run();
      await service.run();
      const [job] = await db
        .select()
        .from(s.jobs)
        .where(eq(s.jobs.dedupeKey, 'database-whatsapp-test'));
      expect(job.status).toBe('done');
      expect(whatsapp.sendOwnerAlert).toHaveBeenCalledTimes(1);
    });
  },
);
