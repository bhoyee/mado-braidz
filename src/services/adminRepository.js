import { and, or, eq, gte, gt, lt, asc, desc, sql, inArray } from 'drizzle-orm';
import { presentAppointment } from './adminAppointment.js';
import { createOwnerSearch } from './ownerSearch.js';
import * as s from '../db/schema.js';

export function createAdminRepository(db) {
  function context(connection, locking = false) {
    return {
      async adminByEmail(email) {
        let query = connection
          .select()
          .from(s.admins)
          .where(eq(s.admins.email, email));
        if (locking) query = query.for('update');
        return (await query)[0];
      },
      async adminById(id) {
        let query = connection
          .select()
          .from(s.admins)
          .where(eq(s.admins.id, id));
        if (locking) query = query.for('update');
        return (await query)[0];
      },
      async adminByReset(hash) {
        let query = connection
          .select()
          .from(s.admins)
          .where(eq(s.admins.resetTokenHash, hash));
        if (locking) query = query.for('update');
        return (await query)[0];
      },
      async saveAdmin(id, values) {
        await connection
          .update(s.admins)
          .set(values)
          .where(eq(s.admins.id, id));
      },
      async audit(values) {
        await connection.insert(s.auditLog).values(values);
      },
    };
  }
  return {
    searchPortal: createOwnerSearch(db),
    ...context(db),
    transaction: (run) => db.transaction((tx) => run(context(tx, true))),
    async ownerTwoFactorEnabled() {
      const [row] = await db
        .select({ enabled: sql`COUNT(*)` })
        .from(s.admins)
        .where(
          and(
            eq(s.admins.role, 'owner'),
            sql`${s.admins.totpSecret} IS NOT NULL AND ${s.admins.totpSecret} <> ''`,
          ),
        );
      return Number(row.enabled) > 0;
    },
    async list({
      from,
      to,
      status,
      paymentStatus,
      search = '',
      limit = 100,
      offset = 0,
      order = 'latest',
      liveAt,
      balanceOnly = false,
      upcomingAt,
    } = {}) {
      const filters = [];
      if (from) filters.push(gte(s.bookings.startAt, from));
      if (to) filters.push(lt(s.bookings.startAt, to));
      if (status) filters.push(eq(s.bookings.status, status));
      if (upcomingAt)
        filters.push(
          or(
            eq(s.bookings.status, 'confirmed'),
            and(
              eq(s.bookings.status, 'pending_payment'),
              gt(s.bookings.holdExpiresAt, upcomingAt),
            ),
          ),
        );
      if (liveAt) filters.push(gt(s.bookings.holdExpiresAt, liveAt));
      if (balanceOnly)
        filters.push(
          inArray(s.bookings.status, ['confirmed', 'completed']),
          gt(s.bookings.balanceCents, 0),
        );
      if (paymentStatus)
        filters.push(eq(s.bookings.paymentStatus, paymentStatus));
      if (search) {
        // LOCATE treats user input as literal text, including % and _.
        const digits = /^[+\d().\s-]+$/.test(search)
          ? search.replace(/\D/g, '')
          : '';
        filters.push(
          sql`(LOCATE(${search}, ${s.clients.name}) > 0 OR LOCATE(${search}, ${s.clients.email}) > 0 OR LOCATE(${search}, ${s.clients.phoneE164}) > 0 OR LOCATE(${search}, ${s.bookings.ref}) > 0 OR (${digits.length >= 4} AND LOCATE(${digits}, ${s.clients.phoneE164}) > 0))`,
        );
      }
      let query = db
        .select({
          booking: s.bookings,
          client: s.clients,
          styleName: s.styles.name,
          paymentReview: sql`EXISTS(SELECT 1 FROM payment_proofs pp WHERE pp.booking_id = ${s.bookings.id} AND pp.status = 'pending')`,
          paymentMethod: sql`COALESCE((SELECT pp.method FROM payment_proofs pp WHERE pp.booking_id = ${s.bookings.id} AND pp.status = 'pending' ORDER BY pp.id DESC LIMIT 1), (SELECT p.method FROM payments p WHERE p.booking_id = ${s.bookings.id} AND p.type <> 'refund' ORDER BY p.id DESC LIMIT 1), CASE WHEN ${s.bookings.stripeCheckoutSessionId} IS NOT NULL THEN 'card' ELSE NULL END)`,
          paymentProvider: sql`CASE WHEN EXISTS(SELECT 1 FROM payment_proofs pp WHERE pp.booking_id = ${s.bookings.id} AND pp.status = 'pending') THEN 'manual' ELSE COALESCE((SELECT p.provider FROM payments p WHERE p.booking_id = ${s.bookings.id} AND p.type <> 'refund' ORDER BY p.id DESC LIMIT 1), CASE WHEN ${s.bookings.stripeCheckoutSessionId} IS NOT NULL THEN 'stripe' ELSE NULL END) END`,
        })
        .from(s.bookings)
        .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
        .innerJoin(s.styles, eq(s.bookings.styleId, s.styles.id))
        .where(and(...filters))
        .orderBy(
          order === 'nearest'
            ? asc(s.bookings.startAt)
            : desc(s.bookings.startAt),
          order === 'nearest' ? asc(s.bookings.id) : desc(s.bookings.id),
        )
        .$dynamic();
      if (limit !== null) query = query.limit(limit).offset(offset);
      return (await query).map(presentAppointment);
    },
    async auditList(offset = 0) {
      return db
        .select({ entry: s.auditLog, name: s.admins.name })
        .from(s.auditLog)
        .innerJoin(s.admins, eq(s.auditLog.adminId, s.admins.id))
        .orderBy(desc(s.auditLog.id))
        .limit(101)
        .offset(offset);
    },
    async receipts({ from, to, limit = 101, offset = 0 }) {
      return db
        .select({ payment: s.payments, booking: s.bookings, client: s.clients })
        .from(s.payments)
        .innerJoin(s.bookings, eq(s.payments.bookingId, s.bookings.id))
        .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
        .where(
          and(gte(s.payments.createdAt, from), lt(s.payments.createdAt, to)),
        )
        .orderBy(desc(s.payments.createdAt), desc(s.payments.id))
        .limit(limit)
        .offset(offset);
    },
    async metrics(startWeek, startMonth, now, today) {
      const [weekly] = await db
        .select({
          total: sql`COALESCE(SUM(CASE WHEN type = 'refund' THEN -amount_cents ELSE amount_cents END), 0)`,
        })
        .from(s.payments)
        .where(
          and(
            gte(s.payments.createdAt, startWeek),
            lt(s.payments.createdAt, now),
          ),
        );
      const [monthly] = await db
        .select({
          total: sql`COALESCE(SUM(CASE WHEN type = 'refund' THEN -amount_cents ELSE amount_cents END), 0)`,
        })
        .from(s.payments)
        .where(
          and(
            gte(s.payments.createdAt, startMonth),
            lt(s.payments.createdAt, now),
          ),
        );
      const [owed] = await db
        .select({ total: sql`COALESCE(SUM(balance_cents), 0)` })
        .from(s.bookings)
        .where(
          and(
            inArray(s.bookings.status, ['confirmed', 'completed']),
            gt(s.bookings.balanceCents, 0),
          ),
        );
      const [pending] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.bookings)
        .where(
          and(
            gte(s.bookings.startAt, today),
            or(
              eq(s.bookings.status, 'confirmed'),
              and(
                eq(s.bookings.status, 'pending_payment'),
                gt(s.bookings.holdExpiresAt, now),
              ),
            ),
          ),
        );
      return {
        week: Number(weekly.total),
        month: Number(monthly.total),
        owed: Number(owed.total),
        pending: Number(pending.count),
      };
    },
    async detail(id) {
      const [booking] = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.id, id));
      if (!booking) return null;
      const [client] = await db
        .select()
        .from(s.clients)
        .where(eq(s.clients.id, booking.clientId));
      const [payments, emails, audits, media] = await Promise.all([
        db
          .select()
          .from(s.payments)
          .where(eq(s.payments.bookingId, id))
          .orderBy(desc(s.payments.createdAt)),
        db
          .select()
          .from(s.emailLog)
          .where(eq(s.emailLog.bookingId, id))
          .orderBy(desc(s.emailLog.createdAt)),
        db
          .select()
          .from(s.auditLog)
          .where(
            and(eq(s.auditLog.entity, 'booking'), eq(s.auditLog.entityId, id)),
          )
          .orderBy(desc(s.auditLog.createdAt)),
        booking.inspirationMediaId
          ? db
              .select()
              .from(s.media)
              .where(eq(s.media.id, booking.inspirationMediaId))
          : [],
      ]);
      return {
        booking,
        client,
        payments,
        emails,
        audits,
        inspiration: media[0],
      };
    },
  };
}
