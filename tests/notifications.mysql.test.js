import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
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
      await repo.saveLog(a.id, { providerId: 'postmark-one', status: 'sent' });
    });
    it('handles out-of-order and replayed callbacks without downgrading a complaint', async () => {
      const event = {
        MessageID: 'postmark-one',
        Recipient: 'client@example.test',
      };
      await repo.delivery({ ...event, RecordType: 'Delivery' });
      await repo.delivery({ ...event, RecordType: 'SpamComplaint' });
      await repo.delivery({ ...event, RecordType: 'Delivery' });
      await repo.delivery({ ...event, RecordType: 'SpamComplaint' });
      expect((await repo.log('job:1:client@example.test')).status).toBe(
        'complained',
      );
      expect(await repo.suppressed('client@example.test')).toBeTruthy();
      expect((await repo.client(1)).marketingConsent).toBe(false);
    });
    it('ignores a callback whose recipient does not match its message', async () => {
      await repo.delivery({
        MessageID: 'postmark-one',
        Recipient: 'other@example.test',
        RecordType: 'Bounce',
        Inactive: true,
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
  },
);
