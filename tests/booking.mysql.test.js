import { createPaymentService } from '../src/services/paymentService.js';
import { fakeStripe, paidEvent, paymentConfig } from './fixtures/stripe.js';
import request from 'supertest';
import { DateTime } from 'luxon';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { createCatalogService } from '../src/services/catalogService.js';
import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDatabase } from '../src/db/index.js';
import { createBookingRepository } from '../src/services/bookingRepository.js';
import { createBookingService } from '../src/services/bookingService.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import * as s from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe.skipIf(process.env.BOOKING_DATABASE_TEST !== '1')(
  'real MySQL row-lock integration (isolated disposable database)',
  () => {
    let admin, pool, db, repository;
    const database = 'mado_booking_test_' + randomBytes(6).toString('hex');
    beforeAll(async () => {
      const source = new URL(
        process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      );
      admin = await mysql.createConnection(source.toString());
      await admin.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
      );
      source.pathname = '/' + database;
      ({ db, pool } = createDatabase(source.toString()));
      await migrate(db, { migrationsFolder: 'src/db/migrations' });
      await db.insert(s.admins).values({
        id: 1,
        email: 'owner@example.test',
        name: 'Test Owner',
        passwordHash: 'unused-in-service-test',
        role: 'owner',
      });
      const { data } = await memoryBookingRepository();
      await db.insert(s.styleCategories).values(data.categories);
      for (const style of data.styles) {
        await db.insert(s.styles).values({
          id: style.id,
          categoryId: data.categories.find((c) => c.slug === style.category).id,
          name: style.name,
          slug: style.slug,
          durationMin: style.durationMin,
          priceOnConsultation: style.priceOnConsultation || false,
          updatedAt: now.toJSDate(),
        });
        if (style.variants.length)
          await db
            .insert(s.styleVariants)
            .values(style.variants.map((v) => ({ ...v, styleId: style.id })));
      }
      await db.insert(s.addons).values(data.addons);
      await db.insert(s.settings).values(
        Object.entries(data.settings).map(([key, value]) => ({
          key,
          value,
          updatedAt: now.toJSDate(),
        })),
      );
      repository = createBookingRepository(db);
    }, 30000);
    beforeEach(async () => {
      await db.delete(s.auditLog);
      await db.delete(s.paymentProofs);
      await db.delete(s.checkoutAttempts);
      await db.delete(s.payments);
      await db.delete(s.stripeEvents);
      await db.delete(s.jobs);
      await db.delete(s.notifications);
      await db.delete(s.bookingAddons);
      await db.delete(s.bookings);
      await db.delete(s.clients);
      await db.delete(s.calendarLocks);
      const { data } = await memoryBookingRepository();
      await db
        .update(s.settings)
        .set({ value: data.settings.booking })
        .where(eq(s.settings.key, 'booking'));
    });
    afterAll(async () => {
      await pool?.end();
      // Only the random database created by this suite may be removed.
      if (admin) {
        if (!/^mado_booking_test_[a-f0-9]{12}$/.test(database))
          throw new Error('Unsafe test database name');
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      }
    });
    it.each([3, 1])(
      'commits exactly %i of 20 simultaneous holds using real row locks',
      async (capacity) => {
        const catalog = await repository.catalog();
        await db
          .update(s.settings)
          .set({ value: { ...catalog.settings.booking, capacity } })
          .where(eq(s.settings.key, 'booking'));
        const service = createBookingService(repository, () => now);
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, () => service.createHold(validHold)),
        );
        const successes = results.filter((r) => r.status === 'fulfilled');
        expect(successes).toHaveLength(capacity);
        expect(
          results
            .filter((r) => r.status === 'rejected')
            .every((r) => r.reason.code === 'SLOT_TAKEN'),
        ).toBe(true);
        const rows = await db.select().from(s.bookings),
          clients = await db.select().from(s.clients);
        expect(rows).toHaveLength(capacity);
        expect(clients).toHaveLength(capacity);
        expect(
          rows.every(
            (r) =>
              r.startAt.toISOString() ===
                validHold.startAt.replace('Z', '.000Z') && r.paidCents === 0,
          ),
        ).toBe(true);
      },
      30000,
    );
    it('persists private proof and approves a manual payment exactly once under concurrent review', async () => {
      const service = createBookingService(
        repository,
        () => now,
        paymentConfig.SESSION_SECRET,
      );
      const hold = await service.createHold(validHold);
      const proof = await service.submitPaymentProof(hold.id, {
        method: 'zelle',
        path: 'private-proof.webp',
      });
      expect((await repository.bookingById(hold.id)).paidCents).toBe(0);
      await Promise.all(
        Array.from({ length: 5 }, () =>
          service.reviewPaymentProof(proof.id, 'approve', {
            id: 1,
            role: 'owner',
          }),
        ),
      );
      expect(await repository.payments(hold.id)).toHaveLength(1);
      expect(await repository.bookingById(hold.id)).toMatchObject({
        status: 'confirmed',
        paidCents: 3000,
        balanceCents: 15000,
      });
      expect((await repository.proof(proof.id)).status).toBe('approved');
      expect(await db.select().from(s.auditLog)).toHaveLength(1);
    }, 30000);
    it('accepts exactly three of 20 simultaneous HTTP requests on the real database', async () => {
      const app = createApp({
        config: parseEnv({
          NODE_ENV: 'test',
          SESSION_SECRET: 'integration-test-secret-at-least-32-characters',
          DATABASE_URL: 'mysql://unused:unused@localhost/mado',
          UPLOAD_DIR: 'tmp/test-unused-uploads',
        }),
        catalog: createCatalogService(db),
        bookingRepository: repository,
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
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          agent
            .post('/api/bookings/hold')
            .set('x-csrf-token', csrf)
            .set('x-forwarded-for', `192.0.2.${i + 1}`)
            .send({ ...validHold, startAt: start }),
        ),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(3);
      expect(results.filter((r) => r.status === 409)).toHaveLength(17);
      expect(await db.select().from(s.bookings)).toHaveLength(3);
    }, 30000);
    it('persists exactly one payment, event and confirmation job under parallel signed-event processing', async () => {
      const service = createBookingService(
        repository,
        () => now,
        paymentConfig.SESSION_SECRET,
      );
      const provider = fakeStripe(),
        payments = createPaymentService(
          repository,
          provider,
          paymentConfig,
          () => now,
        );
      const hold = await service.createHold(validHold);
      const session = await payments.checkout(hold.ref, hold.manageToken);
      await Promise.all(
        Array.from({ length: 12 }, () =>
          payments.handleEvent(
            paidEvent(provider.sessions.get(session.sessionId)),
          ),
        ),
      );
      const [row] = await db.select().from(s.bookings);
      expect(row).toMatchObject({
        status: 'confirmed',
        paymentStatus: 'deposit_paid',
        paidCents: 3000,
        balanceCents: 15000,
      });
      expect(await db.select().from(s.payments)).toHaveLength(1);
      expect(await db.select().from(s.stripeEvents)).toHaveLength(1);
      expect(await db.select().from(s.jobs)).toHaveLength(1);
      expect(await db.select().from(s.notifications)).toHaveLength(1);
    }, 30000);
    it('refunds a late payment with real capacity locks and a durable refund task', async () => {
      let current = now;
      const service = createBookingService(
        repository,
        () => current,
        paymentConfig.SESSION_SECRET,
      );
      const provider = fakeStripe(),
        payments = createPaymentService(
          repository,
          provider,
          paymentConfig,
          () => current,
        );
      const hold = await service.createHold(validHold),
        session = await payments.checkout(hold.ref, hold.manageToken);
      current = now.plus({ minutes: 31 });
      await service.releaseHold(hold.id, 'expired', true);
      await Promise.all(
        Array.from({ length: 3 }, () => service.createHold(validHold)),
      );
      await payments.handleEvent(
        paidEvent(provider.sessions.get(session.sessionId)),
      );
      const [row] = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.id, hold.id));
      expect(row).toMatchObject({
        status: 'payment_conflict',
        paymentStatus: 'refunded',
        paidCents: 0,
      });
      expect((await db.select().from(s.payments)).map((p) => p.type)).toEqual([
        'deposit',
        'refund',
      ]);
      expect(
        (
          await db
            .select()
            .from(s.jobs)
            .where(eq(s.jobs.type, 'refundConflict'))
        )[0].status,
      ).toBe('done');
    }, 30000);
    it('blocks staggered overlaps, snapshots addon money, and admits an expired hold replacement', async () => {
      const service = createBookingService(repository, () => now);
      await service.createHold({ ...validHold, addonIds: [2] });
      await service.createHold({
        ...validHold,
        startAt: '2026-12-03T14:30:00Z',
      });
      await service.createHold({
        ...validHold,
        startAt: '2026-12-03T15:00:00Z',
      });
      await expect(
        service.createHold({ ...validHold, startAt: '2026-12-03T15:30:00Z' }),
      ).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
      const [first] = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.startAt, new Date(validHold.startAt)));
      const snapshot =
        typeof first.priceSnapshot === 'string'
          ? JSON.parse(first.priceSnapshot)
          : first.priceSnapshot;
      expect(snapshot.subtotalCents).toBe(22000);
      expect(await db.select().from(s.bookingAddons)).toHaveLength(1);
      const later = createBookingService(repository, () =>
        now.plus({ minutes: 31 }),
      );
      await later.createHold(validHold);
      expect(await db.select().from(s.bookings)).toHaveLength(4);
    });
  },
);
