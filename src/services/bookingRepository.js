import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { createCatalogService } from './catalogService.js';
import * as s from '../db/schema.js';
import { setTimeout as delay } from 'node:timers/promises';
import { BookingError } from './bookingErrors.js';

function context(db, locking = false) {
  return {
    async batch(id) {
      return (
        await db
          .select()
          .from(s.paymentBatches)
          .where(eq(s.paymentBatches.id, id))
      )[0];
    },
    async batchBySession(id) {
      return (
        await db
          .select()
          .from(s.paymentBatches)
          .where(eq(s.paymentBatches.stripeSessionId, id))
      )[0];
    },
    async batchByIntent(id) {
      return (
        await db
          .select()
          .from(s.paymentBatches)
          .where(eq(s.paymentBatches.stripePaymentIntentId, id))
      )[0];
    },
    async expiredBatches(now) {
      return db
        .select({ id: s.paymentBatches.id })
        .from(s.paymentBatches)
        .where(
          and(
            inArray(s.paymentBatches.status, ['creating', 'open']),
            lt(s.paymentBatches.expiresAt, now),
          ),
        );
    },
    async insertBatch(values) {
      await db.insert(s.paymentBatches).values(values);
    },
    async saveBatch(id, values) {
      await db
        .update(s.paymentBatches)
        .set(values)
        .where(eq(s.paymentBatches.id, id));
    },
    async paymentMatches(kind, value) {
      const field =
        kind === 'email'
          ? s.clients.email
          : kind === 'phone'
            ? s.clients.phoneE164
            : s.bookings.ref;
      return (
        await db
          .select({ booking: s.bookings })
          .from(s.bookings)
          .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
          .where(
            and(
              eq(field, value),
              inArray(s.bookings.status, [
                'pending_payment',
                'confirmed',
                'completed',
              ]),
            ),
          )
          .orderBy(s.bookings.startAt)
      ).map((row) => row.booking);
    },
    async catalog() {
      const catalog = await createCatalogService(db).load();
      const links = await db.select().from(s.addonStyles);
      catalog.addons = catalog.addons.map((a) => ({
        ...a,
        styleIds: links.filter((l) => l.addonId === a.id).map((l) => l.styleId),
      }));
      return catalog;
    },
    async proofs(bookingId) {
      const query = db.select().from(s.paymentProofs);
      return bookingId
        ? query.where(eq(s.paymentProofs.bookingId, bookingId))
        : query;
    },
    async proof(id) {
      return (
        await db
          .select()
          .from(s.paymentProofs)
          .where(eq(s.paymentProofs.id, id))
      )[0];
    },
    async insertProof(values) {
      return (await db.insert(s.paymentProofs).values(values).$returningId())[0]
        .id;
    },
    async saveProof(id, values) {
      await db
        .update(s.paymentProofs)
        .set(values)
        .where(eq(s.paymentProofs.id, id));
    },
    async audit(values) {
      await db.insert(s.auditLog).values(values);
    },
    async lockDates(dates) {
      for (const date of [...new Set(dates)].sort()) {
        await db.execute(
          sql`INSERT IGNORE INTO calendar_locks (date) VALUES (${date})`,
        );
        await db
          .select()
          .from(s.calendarLocks)
          .where(eq(s.calendarLocks.date, date))
          .for('update');
      }
    },
    async schedule(start, end) {
      let query = db
        .select()
        .from(s.bookings)
        .where(
          and(
            lt(s.bookings.startAt, end),
            gt(s.bookings.blockEndAt, start),
            inArray(s.bookings.status, [
              'confirmed',
              'completed',
              'pending_payment',
            ]),
          ),
        );
      let blockQuery = db
        .select()
        .from(s.timeBlocks)
        .where(
          and(lt(s.timeBlocks.startAt, end), gt(s.timeBlocks.endAt, start)),
        );
      if (locking) {
        query = query.for('update');
        blockQuery = blockQuery.for('update');
      }
      return { bookings: await query, timeBlocks: await blockQuery };
    },
    async insertClient(values) {
      const [row] = await db.insert(s.clients).values(values).$returningId();
      return row.id;
    },
    async insertMedia(values) {
      const [row] = await db.insert(s.media).values(values).$returningId();
      return row.id;
    },
    async insertBooking(values, addons) {
      const [row] = await db.insert(s.bookings).values(values).$returningId();
      if (addons.length)
        await db.insert(s.bookingAddons).values(
          addons.map((a) => ({
            bookingId: row.id,
            addonId: a.id,
            nameSnapshot: a.name,
            priceCents: a.priceCents,
            durationMin: a.durationMin,
          })),
        );
      return row.id;
    },
    async bookingById(id) {
      let query = db.select().from(s.bookings).where(eq(s.bookings.id, id));
      if (locking) query = query.for('update');
      return (await query)[0];
    },
    async bookingByRef(ref) {
      return (
        await db.select().from(s.bookings).where(eq(s.bookings.ref, ref))
      )[0];
    },
    async bookingByToken(hash) {
      return (
        await db
          .select()
          .from(s.bookings)
          .where(eq(s.bookings.manageTokenHash, hash))
      )[0];
    },
    async bookingByRequest(key) {
      return (
        await db
          .select()
          .from(s.bookings)
          .where(eq(s.bookings.checkoutRequestKey, key))
      )[0];
    },
    async saveBooking(id, values) {
      await db.update(s.bookings).set(values).where(eq(s.bookings.id, id));
    },
    async client(id) {
      return (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0];
    },
    async attempt(id) {
      return (
        await db
          .select()
          .from(s.checkoutAttempts)
          .where(eq(s.checkoutAttempts.id, id))
      )[0];
    },
    async attemptBySession(id) {
      return (
        await db
          .select()
          .from(s.checkoutAttempts)
          .where(eq(s.checkoutAttempts.stripeSessionId, id))
      )[0];
    },
    async attempts(id) {
      return db
        .select()
        .from(s.checkoutAttempts)
        .where(eq(s.checkoutAttempts.bookingId, id));
    },
    async insertAttempt(values) {
      await db.insert(s.checkoutAttempts).values(values);
    },
    async saveAttempt(id, values) {
      await db
        .update(s.checkoutAttempts)
        .set(values)
        .where(eq(s.checkoutAttempts.id, id));
    },
    async payments(id) {
      return db.select().from(s.payments).where(eq(s.payments.bookingId, id));
    },
    async paymentByIntent(id) {
      return (
        await db
          .select()
          .from(s.payments)
          .where(
            and(
              eq(s.payments.stripePaymentIntentId, id),
              sql`${s.payments.type} <> 'refund'`,
            ),
          )
      )[0];
    },
    async insertPayment(values) {
      await db.insert(s.payments).values(values);
    },
    async event(id, type, now) {
      await db.execute(
        sql`INSERT IGNORE INTO stripe_events (id,type,received_at) VALUES (${id},${type},${now})`,
      );
      return (
        await db
          .select()
          .from(s.stripeEvents)
          .where(eq(s.stripeEvents.id, id))
          .for('update')
      )[0];
    },
    async finishEvent(id, now) {
      await db
        .update(s.stripeEvents)
        .set({ processedAt: now })
        .where(eq(s.stripeEvents.id, id));
    },
    async queueJob(values) {
      await db
        .insert(s.jobs)
        .values(values)
        .onDuplicateKeyUpdate({ set: { dedupeKey: values.dedupeKey } });
    },
    async saveJob(id, values) {
      await db.update(s.jobs).set(values).where(eq(s.jobs.id, id));
    },
    async refundJobs(id) {
      return db
        .select()
        .from(s.jobs)
        .where(
          and(
            eq(s.jobs.type, 'refundConflict'),
            inArray(s.jobs.status, ['pending', 'failed']),
            ...(id
              ? [sql`JSON_EXTRACT(${s.jobs.payload}, '$.bookingId') = ${id}`]
              : []),
          ),
        );
    },
    async notify(values) {
      await db.insert(s.notifications).values(values);
    },
    async expiredHolds(now) {
      return db
        .select({ id: s.bookings.id })
        .from(s.bookings)
        .where(
          and(
            eq(s.bookings.status, 'pending_payment'),
            lt(s.bookings.holdExpiresAt, now),
          ),
        );
    },
  };
}
export function createBookingRepository(db) {
  return {
    ...context(db),
    async transaction(run) {
      // INSERT IGNORE can take shared duplicate-key locks. Concurrent first
      // requests can deadlock while upgrading to FOR UPDATE; retry the entire
      // rolled-back transaction, never just its last statement.
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          return await db.transaction((tx) => run(context(tx, true)), {
            isolationLevel: 'repeatable read',
          });
        } catch (error) {
          const code = error.cause?.code || error.code;
          if (!['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code))
            throw error;
          if (attempt === 7)
            throw new BookingError(
              'BOOKING_BUSY',
              'The calendar is busy. Please try again shortly.',
              503,
            );
          await delay(
            Math.min(250, 10 * 2 ** attempt) + Math.floor(Math.random() * 20),
          );
        }
      }
    },
  };
}
