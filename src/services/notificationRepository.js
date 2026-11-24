import {
  and,
  eq,
  gte,
  gt,
  lte,
  isNull,
  inArray,
  or,
  desc,
  sql,
  lt,
  like,
  getTableColumns,
} from 'drizzle-orm';
import { ALERT_VIEWS, alertLink, alertText, failureText } from './alerts.js';
import * as s from '../db/schema.js';
import { cleanupUploads } from '../jobs/cleanupUploads.js';
const decode = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export function createNotificationRepository(db) {
  return {
    async context(now = new Date()) {
      const [bookings, clients, settings, notifications, styles] =
        await Promise.all([
          db
            .select()
            .from(s.bookings)
            .where(gte(s.bookings.startAt, new Date(+now - 110 * 86400000))),
          db.select().from(s.clients),
          db.select().from(s.settings),
          db
            .select()
            .from(s.notifications)
            .where(
              gte(s.notifications.createdAt, new Date(+now - 7 * 86400000)),
            ),
          db.select({ id: s.styles.id, slug: s.styles.slug }).from(s.styles),
        ]);
      return {
        bookings: bookings.map((b) => ({
          ...b,
          priceSnapshot: decode(b.priceSnapshot),
        })),
        clients,
        settings: Object.fromEntries(
          settings.map((r) => [r.key, decode(r.value)]),
        ),
        notifications,
        styles,
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
      return {
        booking: { ...booking, priceSnapshot: decode(booking.priceSnapshot) },
        client,
      };
    },
    async emailContext(bookingId) {
      const [payments, proofs, markers] = await Promise.all([
        db.select().from(s.payments).where(eq(s.payments.bookingId, bookingId)),
        db
          .select()
          .from(s.paymentProofs)
          .where(
            and(
              eq(s.paymentProofs.bookingId, bookingId),
              eq(s.paymentProofs.status, 'pending'),
            ),
          )
          .orderBy(desc(s.paymentProofs.id))
          .limit(1),
        db
          .select({ dedupeKey: s.jobs.dedupeKey })
          .from(s.jobs)
          .where(
            and(
              eq(s.jobs.type, 'notification-marker'),
              sql`JSON_EXTRACT(${s.jobs.payload}, '$.bookingId') = ${bookingId}`,
            ),
          ),
      ]);
      return {
        payments,
        proof: proofs[0],
        extended: markers.some(
          (m) => m.dedupeKey === `review-extended:${proofs[0]?.id}`,
        ),
      };
    },
    // Transfers waiting for the owner while the chair is still held.
    async pendingReviews() {
      return db
        .select({
          proofId: s.paymentProofs.id,
          submittedAt: s.paymentProofs.createdAt,
          bookingId: s.bookings.id,
          ref: s.bookings.ref,
          holdExpiresAt: s.bookings.holdExpiresAt,
        })
        .from(s.paymentProofs)
        .innerJoin(s.bookings, eq(s.paymentProofs.bookingId, s.bookings.id))
        .where(
          and(
            eq(s.paymentProofs.status, 'pending'),
            sql`${s.paymentProofs.paymentType} <> 'balance'`,
            eq(s.bookings.status, 'pending_payment'),
          ),
        );
    },
    async client(id) {
      return (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0];
    },
    async completedVisitsBefore(booking) {
      const client = await this.client(booking.clientId);
      const email = client?.email?.trim().toLowerCase();
      if (!email) return 0;
      const [row] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.bookings)
        .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
        .where(
          and(
            sql`LOWER(TRIM(${s.clients.email})) = ${email}`,
            eq(s.bookings.status, 'completed'),
            lt(s.bookings.endAt, booking.startAt),
            sql`${s.bookings.id} <> ${booking.id}`,
          ),
        );
      return Number(row.count);
    },
    async queue(values) {
      await db
        .insert(s.jobs)
        .values(values)
        .onDuplicateKeyUpdate({
          set: {
            dedupeKey: values.dedupeKey,
            ...(['reminder', 'winback'].includes(values.type)
              ? {
                  status: sql`IF(${s.jobs.status} = 'cancelled', 'pending', ${s.jobs.status})`,
                }
              : {}),
          },
        });
    },
    async due(now, cutoff) {
      return (
        await db
          .select()
          .from(s.jobs)
          .where(
            and(
              inArray(s.jobs.type, [
                'email',
                'reminder',
                'winback',
                'push',
                'whatsapp',
              ]),
              inArray(s.jobs.status, ['pending', 'failed']),
              lte(s.jobs.runAt, now),
              lt(s.jobs.attempts, 5),
              or(
                gte(s.jobs.createdAt, cutoff),
                and(
                  inArray(s.jobs.type, ['reminder', 'winback']),
                  gte(s.jobs.runAt, cutoff),
                ),
              ),
            ),
          )
          .orderBy(s.jobs.runAt)
          .limit(50)
      ).map((j) => ({ ...j, payload: decode(j.payload) }));
    },
    async pending() {
      return (
        await db
          .select()
          .from(s.jobs)
          .where(
            and(
              inArray(s.jobs.type, ['reminder', 'winback']),
              inArray(s.jobs.status, ['pending', 'failed']),
            ),
          )
      ).map((j) => ({ ...j, payload: decode(j.payload) }));
    },
    async saveJob(id, patch) {
      await db.update(s.jobs).set(patch).where(eq(s.jobs.id, id));
    },
    async log(key) {
      return (
        await db
          .select()
          .from(s.emailLog)
          .where(eq(s.emailLog.deliveryKey, key))
      )[0];
    },
    async reserveLog(values) {
      await db
        .insert(s.emailLog)
        .values(values)
        .onDuplicateKeyUpdate({ set: { deliveryKey: values.deliveryKey } });
      return this.log(values.deliveryKey);
    },
    async saveLog(id, patch) {
      await db.update(s.emailLog).set(patch).where(eq(s.emailLog.id, id));
    },
    async suppressed(email) {
      return (
        await db
          .select()
          .from(s.emailSuppressions)
          .where(eq(s.emailSuppressions.email, email.toLowerCase()))
      )[0];
    },
    async delivery(event) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(s.emailLog)
          .where(
            or(
              eq(s.emailLog.providerId, event.providerId),
              eq(s.emailLog.deliveryKey, event.deliveryKey || '-'),
            ),
          )
          .for('update');
        if (!row || row.toEmail.toLowerCase() !== event.recipient.toLowerCase())
          return;
        const rank = {
          pending: 0,
          sending: 0,
          deferred: 1,
          sent: 1,
          delivered: 2,
          blocked: 3,
          bounced: 3,
          unsubscribed: 4,
          complained: 5,
        };
        if ((rank[event.kind] || 0) > (rank[row.status] || 0))
          await tx
            .update(s.emailLog)
            .set({ status: event.kind, providerId: event.providerId })
            .where(eq(s.emailLog.id, row.id));
        if (event.suppress)
          await tx
            .insert(s.emailSuppressions)
            .values({ email: row.toEmail.toLowerCase(), reason: event.kind })
            .onDuplicateKeyUpdate({ set: { reason: event.kind } });
        if (['complained', 'unsubscribed'].includes(event.kind)) {
          await tx
            .update(s.clients)
            .set({ marketingConsent: false, unsubscribedAt: new Date() })
            .where(eq(s.clients.email, row.toEmail));
          if (row.clientId)
            await tx
              .update(s.jobs)
              .set({ status: 'cancelled' })
              .where(
                and(
                  eq(s.jobs.type, 'winback'),
                  inArray(s.jobs.status, ['pending', 'failed']),
                  sql`JSON_EXTRACT(${s.jobs.payload}, '$.clientId') = ${row.clientId}`,
                ),
              );
        }
      });
    },
    async unsubscribe(id) {
      await db.transaction(async (tx) => {
        const [client] = await tx
          .select()
          .from(s.clients)
          .where(eq(s.clients.id, id));
        if (!client) return;
        // One choice covers every booking made with this email.
        const rows = await tx
          .select({ id: s.clients.id })
          .from(s.clients)
          .where(
            sql`LOWER(TRIM(${s.clients.email})) = ${client.email.trim().toLowerCase()}`,
          );
        const ids = rows.map((row) => row.id);
        await tx
          .update(s.clients)
          .set({ marketingConsent: false, unsubscribedAt: new Date() })
          .where(inArray(s.clients.id, ids));
        await tx
          .update(s.jobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(s.jobs.type, 'winback'),
              inArray(s.jobs.status, ['pending', 'failed']),
              sql`JSON_EXTRACT(${s.jobs.payload}, '$.clientId') IN (${sql.join(ids, sql`, `)})`,
            ),
          );
      });
    },
    visibleTo(adminId) {
      return or(
        isNull(s.notifications.adminId),
        eq(s.notifications.adminId, adminId),
      );
    },
    // Each owner reads their own alerts. `readAt` on the alert itself is from
    // before that, and still means read by everyone.
    unreadBy(adminId) {
      return and(
        isNull(s.notifications.readAt),
        sql`NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = ${s.notifications.id} AND r.admin_id = ${adminId})`,
      );
    },
    // Alerts in plain words, with the live appointment behind each one.
    async worded(rows, names = true) {
      const links = rows.map(alertLink);
      const ids = [...new Set(links.map((link) => link.id).filter(Boolean))];
      const refs = [...new Set(links.map((link) => link.ref).filter(Boolean))];
      const details =
        ids.length || refs.length
          ? await db
              .select({ booking: s.bookings, client: s.clients })
              .from(s.bookings)
              .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
              .where(
                or(
                  ...(ids.length ? [inArray(s.bookings.id, ids)] : []),
                  ...(refs.length ? [inArray(s.bookings.ref, refs)] : []),
                ),
              )
          : [];
      for (const { booking } of details)
        booking.priceSnapshot = decode(booking.priceSnapshot);
      return rows.map((row, index) => {
        const { id, ref } = links[index];
        const detail = details.find(
          (item) =>
            (id && item.booking.id === id) || (ref && item.booking.ref === ref),
        );
        return { ...row, ...alertText(row, detail, { names }) };
      });
    },
    async notifications(adminId, since = 0) {
      const visible = this.visibleTo(adminId);
      const rows = await db
        .select({
          ...getTableColumns(s.notifications),
          ownReadAt: s.notificationReads.readAt,
        })
        .from(s.notifications)
        .leftJoin(
          s.notificationReads,
          and(
            eq(s.notificationReads.notificationId, s.notifications.id),
            eq(s.notificationReads.adminId, adminId),
          ),
        )
        .where(and(visible, gt(s.notifications.id, since)))
        .orderBy(desc(s.notifications.id))
        .limit(20);
      const [unread] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.notifications)
        .where(and(visible, this.unreadBy(adminId)));
      const items = await this.worded(
        rows.map(({ ownReadAt, ...row }) => ({
          ...row,
          readAt: row.readAt || ownReadAt,
        })),
      );
      return { items, unread: Number(unread.count) };
    },
    async feed(adminId, { view = 'all', page = 1, size = 20 } = {}) {
      const where = and(
        this.visibleTo(adminId),
        ...(view === 'unread' ? [this.unreadBy(adminId)] : []),
        ...(ALERT_VIEWS[view]?.types
          ? [inArray(s.notifications.type, ALERT_VIEWS[view].types)]
          : []),
      );
      const [{ count }] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.notifications)
        .where(where);
      const total = Number(count);
      const last = Math.max(1, Math.ceil(total / size));
      const current = Math.min(Math.max(1, page), last);
      const rows = await db
        .select({
          ...getTableColumns(s.notifications),
          ownReadAt: s.notificationReads.readAt,
        })
        .from(s.notifications)
        .leftJoin(
          s.notificationReads,
          and(
            eq(s.notificationReads.notificationId, s.notifications.id),
            eq(s.notificationReads.adminId, adminId),
          ),
        )
        .where(where)
        .orderBy(desc(s.notifications.id))
        .limit(size)
        .offset((current - 1) * size);
      const [unread] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.notifications)
        .where(and(this.visibleTo(adminId), this.unreadBy(adminId)));
      return {
        items: await this.worded(
          rows.map(({ ownReadAt, ...row }) => ({
            ...row,
            readAt: row.readAt || ownReadAt,
          })),
        ),
        unread: Number(unread.count),
        total,
        page: current,
        last,
        first: total ? (current - 1) * size + 1 : 0,
      };
    },
    // Returns what changed, so it can be undone.
    async markRead(adminId, id) {
      const rows = await db
        .select({ id: s.notifications.id })
        .from(s.notifications)
        .where(
          and(
            this.visibleTo(adminId),
            this.unreadBy(adminId),
            ...(id ? [eq(s.notifications.id, id)] : []),
          ),
        );
      const ids = rows.map((row) => row.id);
      const readAt = new Date();
      for (let at = 0; at < ids.length; at += 500)
        await db
          .insert(s.notificationReads)
          .values(
            ids
              .slice(at, at + 500)
              .map((notificationId) => ({ notificationId, adminId, readAt })),
          )
          .onDuplicateKeyUpdate({ set: { adminId } });
      return ids;
    },
    async markUnread(adminId, ids) {
      if (ids.length)
        await db
          .delete(s.notificationReads)
          .where(
            and(
              eq(s.notificationReads.adminId, adminId),
              inArray(s.notificationReads.notificationId, ids),
            ),
          );
    },
    async readers(notificationId) {
      return new Set(
        (
          await db
            .select({ adminId: s.notificationReads.adminId })
            .from(s.notificationReads)
            .where(eq(s.notificationReads.notificationId, notificationId))
        ).map((row) => row.adminId),
      );
    },
    // Things only the owner can finish. Each leaves as soon as it is handled.
    async needsYou() {
      const reviews = await db
        .select({
          proofId: s.paymentProofs.id,
          method: s.paymentProofs.method,
          paymentType: s.paymentProofs.paymentType,
          amountCents: s.paymentProofs.amountCents,
          submittedAt: s.paymentProofs.createdAt,
          bookingId: s.bookings.id,
          status: s.bookings.status,
          startAt: s.bookings.startAt,
          holdExpiresAt: s.bookings.holdExpiresAt,
          snapshot: s.bookings.priceSnapshot,
          name: s.clients.name,
        })
        .from(s.paymentProofs)
        .innerJoin(s.bookings, eq(s.paymentProofs.bookingId, s.bookings.id))
        .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
        .where(eq(s.paymentProofs.status, 'pending'))
        .orderBy(s.paymentProofs.createdAt);
      return {
        reviews: reviews.map(({ snapshot, ...row }) => ({
          ...row,
          style: decode(snapshot)?.styleName,
          deadline: row.status === 'pending_payment' ? row.holdExpiresAt : null,
        })),
        failures: await this.failures(),
      };
    },
    async failures(id) {
      const rows = await db
        .select()
        .from(s.jobs)
        .where(
          and(
            eq(s.jobs.status, 'failed'),
            gte(s.jobs.attempts, 3),
            inArray(s.jobs.type, [
              'email',
              'reminder',
              'winback',
              'whatsapp',
              'refundConflict',
            ]),
            gte(s.jobs.createdAt, new Date(Date.now() - 60 * 86400000)),
            ...(id ? [eq(s.jobs.id, id)] : []),
          ),
        )
        .orderBy(desc(s.jobs.id))
        .limit(30);
      const list = [];
      for (const job of rows) {
        const payload = decode(job.payload);
        if (['password-reset', 'owner-test'].includes(payload.template))
          continue;
        const detail = payload.bookingId
          ? await this.detail(payload.bookingId)
          : null;
        const [unclear] = await db
          .select({ id: s.emailLog.id })
          .from(s.emailLog)
          .where(
            and(
              like(s.emailLog.deliveryKey, `job:${job.id}:%`),
              inArray(s.emailLog.status, ['unknown', 'sending']),
            ),
          )
          .limit(1);
        const uncertain =
          Boolean(unclear) ||
          job.type === 'whatsapp' ||
          /verif/i.test(job.lastError || '');
        const refund = job.type === 'refundConflict';
        const toOwner = ['admin-alert', 'daily-agenda', 'contact-enquiry'];
        list.push({
          id: job.id,
          template: payload.template,
          refund,
          whatsapp: job.type === 'whatsapp',
          bookingId: payload.bookingId || null,
          name:
            toOwner.includes(payload.template) || job.type === 'whatsapp'
              ? 'you'
              : detail?.client?.name || 'a client',
          reason: refund
            ? 'The refund did not go through. It is tried again by itself.'
            : failureText(job.lastError, uncertain),
          canRetry: !refund && !uncertain,
          canDismiss: !refund,
          at: job.createdAt,
        });
      }
      return list;
    },
    // Only when nothing can have been delivered already.
    async retryFailure(id, now = new Date()) {
      const [failure] = await this.failures(id);
      if (!failure?.canRetry) return false;
      await db
        .update(s.jobs)
        .set({ status: 'pending', attempts: 0, lastError: null, runAt: now })
        .where(and(eq(s.jobs.id, id), eq(s.jobs.status, 'failed')));
      return true;
    },
    async dismissFailure(id) {
      const [failure] = await this.failures(id);
      if (!failure?.canDismiss) return false;
      await db
        .update(s.jobs)
        .set({ status: 'done', lastError: 'Dismissed by the owner' })
        .where(and(eq(s.jobs.id, id), eq(s.jobs.status, 'failed')));
      return true;
    },
    async saveAlertPreferences(adminId, { email, ...own }) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(s.settings)
          .where(eq(s.settings.key, 'alerts'))
          .for('update');
        const old = decode(row?.value) || {};
        const value = {
          ...old,
          email,
          owners: { ...old.owners, [adminId]: own },
        };
        await tx
          .insert(s.settings)
          .values({
            key: 'alerts',
            value,
            updatedBy: adminId,
            updatedAt: new Date(),
          })
          .onDuplicateKeyUpdate({
            set: { value, updatedBy: adminId, updatedAt: new Date() },
          });
      });
    },
    // Shared with the server timer, so an alert is never sent twice.
    async withLock(fn) {
      const connection = await db.$client.getConnection();
      try {
        const [[row]] = await connection.query(
          "SELECT GET_LOCK('jobs',0) AS acquired",
        );
        if (row.acquired !== 1) return false;
        try {
          await fn();
        } finally {
          await connection.query("SELECT RELEASE_LOCK('jobs')");
        }
        return true;
      } finally {
        connection.release();
      }
    },
    async recentNotifications(since) {
      return db
        .select()
        .from(s.notifications)
        .where(gte(s.notifications.createdAt, since));
    },
    async notification(id) {
      return (
        await db
          .select()
          .from(s.notifications)
          .where(eq(s.notifications.id, id))
      )[0];
    },
    async notify(values) {
      await db.insert(s.notifications).values(values);
    },
    async notifyOnce(key, values) {
      await db.transaction(async (tx) => {
        const dedupeKey = `notification:${key}`;
        const [old] = await tx
          .select()
          .from(s.jobs)
          .where(eq(s.jobs.dedupeKey, dedupeKey))
          .for('update');
        if (old) return;
        const [existing] = await tx
          .select()
          .from(s.notifications)
          .where(
            and(
              eq(s.notifications.type, values.type),
              eq(s.notifications.url, values.url),
            ),
          );
        if (!existing || values.type !== 'booking_confirmed')
          await tx.insert(s.notifications).values(values);
        await tx.insert(s.jobs).values({
          type: 'notification-marker',
          payload: {},
          dedupeKey,
          runAt: new Date(),
          status: 'done',
        });
      });
    },
    async lifecycleJobs(cutoff) {
      return (
        await db
          .select()
          .from(s.jobs)
          .where(and(eq(s.jobs.type, 'email'), gte(s.jobs.createdAt, cutoff)))
      ).map((j) => ({ ...j, payload: decode(j.payload) }));
    },
    async subscriptions(adminId) {
      return (
        await db
          .select()
          .from(s.pushSubscriptions)
          .where(adminId ? eq(s.pushSubscriptions.adminId, adminId) : undefined)
      ).map((r) => ({ ...r, keys: decode(r.keys) }));
    },
    async saveSubscription(adminId, input, label = null) {
      const [existing] = await db
        .select()
        .from(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.endpoint, input.endpoint));
      // Holding the same private keys proves it is the same browser, now used
      // by another owner. Its alerts move to whoever is signed in.
      const keys = decode(existing?.keys);
      if (
        existing &&
        existing.adminId !== adminId &&
        (keys.auth !== input.keys.auth || keys.p256dh !== input.keys.p256dh)
      )
        throw new Error('Subscription belongs to another owner');
      await db
        .insert(s.pushSubscriptions)
        .values({ adminId, ...input, label })
        .onDuplicateKeyUpdate({
          set: { adminId, keys: input.keys, ...(label ? { label } : {}) },
        });
    },
    async removeDevice(id, adminId) {
      await db
        .delete(s.pushSubscriptions)
        .where(
          and(
            eq(s.pushSubscriptions.id, id),
            eq(s.pushSubscriptions.adminId, adminId),
          ),
        );
    },
    async removeDevices(adminId) {
      await db
        .delete(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.adminId, adminId));
    },
    async deleteSubscription(endpoint, adminId) {
      await db
        .delete(s.pushSubscriptions)
        .where(
          and(
            eq(s.pushSubscriptions.endpoint, endpoint),
            ...(adminId ? [eq(s.pushSubscriptions.adminId, adminId)] : []),
          ),
        );
    },
    async saveTemplates(value, adminId) {
      await db
        .insert(s.settings)
        .values({
          key: 'emailTemplates',
          value,
          updatedBy: adminId,
          updatedAt: new Date(),
        })
        .onDuplicateKeyUpdate({
          set: { value, updatedBy: adminId, updatedAt: new Date() },
        });
    },
    async cleanup(now, uploadDir) {
      await db
        .delete(s.sessions)
        .where(lt(s.sessions.expires, Math.floor(+now / 1000)));
      await db
        .delete(s.stripeEvents)
        .where(
          and(lt(s.stripeEvents.processedAt, new Date(+now - 90 * 86400000))),
        );
      // Read alerts go after 90 days. Unread ones stay.
      await db
        .delete(s.notifications)
        .where(
          and(
            lt(s.notifications.createdAt, new Date(+now - 90 * 86400000)),
            sql`(${s.notifications.readAt} IS NOT NULL OR EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = ${s.notifications.id}))`,
          ),
        );
      const [last] = await db
        .select()
        .from(s.settings)
        .where(eq(s.settings.key, 'notifications_cleanup'));
      if (
        uploadDir &&
        (!last || +now - +new Date(decode(last.value).at) > 7 * 86400000)
      ) {
        const [videoSettings] = await db
          .select()
          .from(s.settings)
          .where(eq(s.settings.key, 'videos'));
        await cleanupUploads(
          uploadDir,
          await db.select().from(s.media),
          await db.select().from(s.paymentProofs),
          now,
          videoSettings ? decode(videoSettings.value).items || [] : [],
        );
        const value = { at: now.toISOString() };
        await db
          .insert(s.settings)
          .values({ key: 'notifications_cleanup', value, updatedAt: now })
          .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
      }
    },
    // Proof that the server timer is running.
    async heartbeat(now = new Date()) {
      const value = { at: now.toISOString() };
      await db
        .insert(s.settings)
        .values({ key: 'jobs_heartbeat', value, updatedAt: now })
        .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
    },
    async failedJobs() {
      return (
        await db
          .select()
          .from(s.jobs)
          .where(
            and(
              inArray(s.jobs.status, ['pending', 'failed']),
              gte(s.jobs.attempts, 3),
              inArray(s.jobs.type, [
                'email',
                'reminder',
                'winback',
                'refundConflict',
              ]),
            ),
          )
      ).map((j) => ({ ...j, payload: decode(j.payload) }));
    },
    async webhookFailure(eventId) {
      const dedupeKey = `webhook-failure:${eventId}`;
      await db
        .insert(s.jobs)
        .values({
          type: 'webhook-failure',
          payload: { eventId },
          dedupeKey,
          runAt: new Date(),
          status: 'failed',
          attempts: 1,
        })
        .onDuplicateKeyUpdate({ set: { attempts: sql`${s.jobs.attempts}+1` } });
      const [row] = await db
        .select()
        .from(s.jobs)
        .where(eq(s.jobs.dedupeKey, dedupeKey));
      if (row.attempts === 3)
        await this.notifyOnce(dedupeKey, {
          type: 'webhook_failure',
          title: 'Payment webhook needs attention',
          body: 'Stripe could not complete a payment update after three attempts.',
          url: '/admin/notifications',
        });
    },
  };
}
