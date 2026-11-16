import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { createCatalogService } from './catalogService.js';
import * as s from '../db/schema.js';
import { setTimeout as delay } from 'node:timers/promises';
import { BookingError } from './bookingErrors.js';

function context(db, locking = false) {
  return {
    async catalog() {
      const catalog = await createCatalogService(db).load();
      const links = await db.select().from(s.addonStyles);
      catalog.addons = catalog.addons.map((a) => ({
        ...a,
        styleIds: links.filter((l) => l.addonId === a.id).map((l) => l.styleId),
      }));
      return catalog;
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
