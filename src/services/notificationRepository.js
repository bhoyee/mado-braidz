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
} from 'drizzle-orm';
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
    async client(id) {
      return (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0];
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
              inArray(s.jobs.type, ['email', 'reminder', 'winback', 'push']),
              inArray(s.jobs.status, ['pending', 'failed']),
              lte(s.jobs.runAt, now),
              lt(s.jobs.attempts, 5),
              gte(s.jobs.createdAt, cutoff),
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
        if (event.RecordType === 'SubscriptionChange') {
          if (!event.SuppressSending) return;
          const recipient = (event.Recipient || '').toLowerCase();
          if (!recipient) return;
          await tx
            .update(s.clients)
            .set({ marketingConsent: false, unsubscribedAt: new Date() })
            .where(eq(s.clients.email, recipient));
          if (['HardBounce', 'SpamComplaint'].includes(event.SuppressionReason))
            await tx
              .insert(s.emailSuppressions)
              .values({ email: recipient, reason: event.SuppressionReason })
              .onDuplicateKeyUpdate({
                set: { reason: event.SuppressionReason },
              });
          if (!event.MessageID) return;
        }
        const [row] = await tx
          .select()
          .from(s.emailLog)
          .where(
            or(
              eq(s.emailLog.providerId, event.MessageID || '-'),
              eq(s.emailLog.deliveryKey, event.Metadata?.deliveryKey || '-'),
            ),
          )
          .for('update');
        if (
          !row ||
          row.toEmail.toLowerCase() !==
            (event.Recipient || event.Email || '').toLowerCase()
        )
          return;
        const status = {
          Delivery: 'delivered',
          Bounce: 'bounced',
          SpamComplaint: 'complained',
          SubscriptionChange: 'unsubscribed',
        }[event.RecordType];
        const rank = {
          sending: 0,
          sent: 1,
          delivered: 2,
          bounced: 3,
          unsubscribed: 4,
          complained: 5,
        };
        if (status && (rank[status] || 0) > (rank[row.status] || 0))
          await tx
            .update(s.emailLog)
            .set({ status, providerId: event.MessageID })
            .where(eq(s.emailLog.id, row.id));
        if (
          event.RecordType === 'SpamComplaint' ||
          (event.RecordType === 'Bounce' && event.Inactive === true)
        )
          await tx
            .insert(s.emailSuppressions)
            .values({ email: row.toEmail.toLowerCase(), reason: status })
            .onDuplicateKeyUpdate({ set: { reason: status } });
        if (
          event.RecordType === 'SpamComplaint' ||
          (event.RecordType === 'SubscriptionChange' &&
            event.SuppressSending === true)
        )
          await tx
            .update(s.clients)
            .set({ unsubscribedAt: new Date(), marketingConsent: false })
            .where(eq(s.clients.email, row.toEmail));
      });
    },
    async unsubscribe(id) {
      await db.transaction(async (tx) => {
        await tx
          .update(s.clients)
          .set({ marketingConsent: false, unsubscribedAt: new Date() })
          .where(eq(s.clients.id, id));
        await tx
          .update(s.jobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(s.jobs.type, 'winback'),
              inArray(s.jobs.status, ['pending', 'failed']),
              sql`JSON_EXTRACT(${s.jobs.payload}, '$.clientId') = ${id}`,
            ),
          );
      });
    },
    async notifications(adminId, since = 0) {
      const visible = or(
        isNull(s.notifications.adminId),
        eq(s.notifications.adminId, adminId),
      );
      const items = await db
        .select()
        .from(s.notifications)
        .where(and(visible, gt(s.notifications.id, since)))
        .orderBy(desc(s.notifications.id))
        .limit(100);
      const [unread] = await db
        .select({ count: sql`COUNT(*)` })
        .from(s.notifications)
        .where(and(visible, isNull(s.notifications.readAt)));
      return { items, unread: Number(unread.count) };
    },
    async markRead(adminId, id) {
      await db
        .update(s.notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            or(
              isNull(s.notifications.adminId),
              eq(s.notifications.adminId, adminId),
            ),
            ...(id ? [eq(s.notifications.id, id)] : []),
          ),
        );
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
    async saveSubscription(adminId, input) {
      const [existing] = await db
        .select()
        .from(s.pushSubscriptions)
        .where(eq(s.pushSubscriptions.endpoint, input.endpoint));
      if (existing && existing.adminId !== adminId)
        throw new Error('Subscription belongs to another owner');
      await db
        .insert(s.pushSubscriptions)
        .values({ adminId, ...input })
        .onDuplicateKeyUpdate({ set: { keys: input.keys } });
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
      const [last] = await db
        .select()
        .from(s.settings)
        .where(eq(s.settings.key, 'notifications_cleanup'));
      if (
        uploadDir &&
        (!last || +now - +new Date(decode(last.value).at) > 7 * 86400000)
      ) {
        await cleanupUploads(
          uploadDir,
          await db.select().from(s.media),
          await db.select().from(s.paymentProofs),
          now,
        );
        const value = { at: now.toISOString() };
        await db
          .insert(s.settings)
          .values({ key: 'notifications_cleanup', value, updatedAt: now })
          .onDuplicateKeyUpdate({ set: { value, updatedAt: now } });
      }
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
