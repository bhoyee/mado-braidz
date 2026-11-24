import { REMOVED_DOMAIN, personIds, wantsNews } from './clientGroups.js';
import { DateTime } from 'luxon';
import {
  alertPreferences,
  emailAllowed,
  isUrgent,
  pushAllowed,
  quietUntil,
} from './alerts.js';
import * as webpush from 'web-push';
import { createWhatsAppService } from './whatsappService.js';
import { whatsappBookingMessage } from './whatsappBookingMessage.js';
import { createHash } from 'node:crypto';
import {
  createEmailService,
  renderEmail,
  unsubscribeToken,
  validUnsubscribe,
} from './emailService.js';
const ZONE = 'America/New_York';
const acceptedStatuses = new Set([
  'sent',
  'delivered',
  'deferred',
  'blocked',
  'bounced',
  'complained',
  'unsubscribed',
  'preview',
]);
const decode = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export function reminderTimes(booking, hours = 48) {
  const start = DateTime.fromJSDate(new Date(booking.startAt), { zone: ZONE });
  let morning = start.startOf('day').set({ hour: 7 });
  if (morning >= start) morning = start.minus({ hours: 1 });
  return {
    first: start.minus({ hours }).toUTC().toJSDate(),
    morning: morning.toUTC().toJSDate(),
  };
}
export function marketingEligible(
  booking,
  client,
  all,
  now = new Date(),
  clients = client ? [client] : [],
  links = {},
) {
  if (booking.status !== 'completed' || !wantsNews(client, clients))
    return false;
  // Every booking has its own client record, so look at the whole person.
  const person = new Set(personIds(clients, booking.clientId, links));
  return !all.some(
    (other) =>
      other.id !== booking.id &&
      person.has(other.clientId) &&
      ((['pending_payment', 'confirmed'].includes(other.status) &&
        other.startAt > booking.completedAt &&
        (!other.holdExpiresAt || other.holdExpiresAt > now)) ||
        (other.status === 'completed' &&
          other.completedAt > booking.completedAt)),
  );
}
export function createNotificationService(
  repository,
  config,
  {
    email = createEmailService(config),
    clock = () => new Date(),
    push = webpush,
    whatsapp = createWhatsAppService(config),
  } = {},
) {
  const cutoff = () => new Date(config.NOTIFICATIONS_START_AT || 0);
  const queue = (template, payload, key, runAt = clock(), type = 'email') =>
    repository.queue({
      type,
      payload: { ...payload, template },
      dedupeKey: key,
      runAt,
      status: 'pending',
      createdAt: clock(),
    });
  function alertRecipients(settings) {
    const values = settings.emails?.adminAlertEmails?.length
      ? settings.emails.adminAlertEmails
      : (config.ADMIN_ALERT_EMAILS || config.ADMIN_EMAIL || '').split(',');
    return [
      ...new Set(
        values
          .map((v) => v.trim().toLowerCase())
          .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)),
      ),
    ];
  }
  async function mailExtras(p, detail, state) {
    if (p.template !== 'admin-alert')
      return detail
        ? ((await repository.emailContext?.(detail.booking.id)) ?? {})
        : {};
    const notification =
      p.notificationId && (await repository.notification(p.notificationId));
    if (!notification) return {};
    const id = Number(
      /^\/admin\/bookings\/(\d+)$/.exec(notification.url || '')?.[1],
    );
    const linked = state.bookings.find(
      (b) => b.id === id || b.ref === notification.body?.split(':')[0],
    );
    const linkedDetail = linked && (await repository.detail(linked.id));
    if (!linkedDetail?.client) return {};
    return {
      ...(await repository.emailContext?.(linked.id)),
      visits: await repository.completedVisitsBefore?.(linkedDetail.booking),
      alert: { kind: notification.type, detail: linkedDetail },
    };
  }
  async function eligible(job, state) {
    const p = decode(job.payload);
    if (p.expiresAt && new Date(p.expiresAt) <= clock()) return false;
    // A review reminder is pointless once the owner has decided.
    if (p.reviewBookingId) {
      const held = await repository.detail(p.reviewBookingId);
      return (
        held?.booking.status === 'pending_payment' &&
        Boolean((await repository.emailContext?.(p.reviewBookingId))?.proof)
      );
    }
    if (!p.bookingId) return true;
    const detail = await repository.detail(p.bookingId);
    if (!detail) return false;
    const { booking, client } = detail;
    if (p.startAt && +new Date(p.startAt) !== +new Date(booking.startAt))
      return false;
    if (job.type === 'winback')
      return (
        booking.completedAt >= cutoff() &&
        marketingEligible(
          booking,
          client,
          state.bookings,
          clock(),
          state.clients,
          state.settings.clientLinks,
        ) &&
        state.settings.emails?.winback === true
      );
    if (job.type === 'reminder')
      return (
        booking.status === 'confirmed' &&
        booking.startAt > clock() &&
        +clock() - +job.runAt < 2 * 3600000
      );
    // Reviewed before this was sent: the result email replaces it.
    if (p.template === 'payment-submitted')
      return (
        (await repository.emailContext?.(p.bookingId))?.proof?.id === p.proofId
      );
    // The owner may have confirmed the client another way in the meantime.
    if (p.template === 'payment-review-expired')
      return booking.status === 'expired';
    if (p.template === 'payment-rejected')
      return p.paymentType === 'balance' || booking.status !== 'confirmed';
    if (p.template === 'thank-you') return booking.status === 'completed';
    if (['booking-confirmation', 'booking-rescheduled'].includes(p.template))
      return booking.status === 'confirmed';
    if (p.template === 'booking-cancelled')
      return booking.status === 'cancelled';
    if (p.template === 'deposit-payment')
      return (
        booking.status === 'pending_payment' && booking.holdExpiresAt > clock()
      );
    if (p.template === 'balance-payment')
      return (
        ['confirmed', 'completed'].includes(booking.status) &&
        booking.balanceCents > 0
      );
    return true;
  }
  async function queueAlerts(list, state, now) {
    for (const notification of list.filter((n) => n.createdAt >= cutoff())) {
      if (
        config.WHATSAPP_ALERTS_ENABLED &&
        ['booking_confirmed', 'payment_review'].includes(notification.type) &&
        notification.createdAt >= new Date(config.WHATSAPP_ALERTS_START_AT)
      )
        await queue(
          'owner-whatsapp',
          { notificationId: notification.id },
          `whatsapp:${notification.id}`,
          now,
          'whatsapp',
        );
      await queue(
        'push',
        { notificationId: notification.id },
        `push:${notification.id}`,
        now,
        'push',
      );
      if (emailAllowed(state.settings.alerts, notification.type))
        await queue(
          'admin-alert',
          {
            notificationId: notification.id,
            body: notification.title,
            url: notification.url,
            ...(['payment_review_reminder', 'payment_review_urgent'].includes(
              notification.type,
            )
              ? {
                  reviewBookingId: Number(/(\d+)$/.exec(notification.url)?.[1]),
                }
              : {}),
          },
          `owner-notification:${notification.id}`,
        );
    }
  }
  const vapid = () => ({
    subject: config.VAPID_SUBJECT,
    publicKey: config.VAPID_PUBLIC_KEY,
    privateKey: config.VAPID_PRIVATE_KEY,
  });
  // Sends to each device once, even when another device needs a retry.
  // Returns the time to try again when some owners are in quiet hours.
  async function sendPush(job, p, state) {
    const n = await repository.notification(p.notificationId);
    if (!n) return null;
    const done = new Set(p.delivered || []);
    const readers = (await repository.readers?.(n.id)) || new Set();
    let later = null,
      problem = false;
    for (const sub of await repository.subscriptions(n.adminId)) {
      const key = sub.id ?? sub.endpoint;
      if (done.has(key)) continue;
      const prefs = alertPreferences(state.settings.alerts, sub.adminId);
      if (!pushAllowed(prefs, n.type)) continue;
      // Already seen before quiet hours ended.
      if (readers.has(sub.adminId) || n.readAt) continue;
      const until = isUrgent(n.type) ? null : quietUntil(prefs, clock());
      if (until) {
        if (!later || until < later) later = until;
        continue;
      }
      const [text] = repository.worded
        ? await repository.worded([n], prefs.names)
        : [{ title: n.title, body: 'Open your owner studio to see it.' }];
      try {
        await push.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({
            title: text.title,
            body: text.body,
            url: n.url?.startsWith('/admin') ? n.url : '/admin/notifications',
            tag: `mado-${n.id}`,
          }),
          {
            vapidDetails: vapid(),
            TTL: 3600,
            timeout: 10000,
            ...(isUrgent(n.type) ? { urgency: 'high' } : {}),
          },
        );
        done.add(key);
      } catch (error) {
        if ([404, 410].includes(error.statusCode))
          await repository.deleteSubscription(sub.endpoint);
        else problem = true;
      }
    }
    if (done.size) {
      p.delivered = [...done];
      await repository.saveJob(job.id, { payload: p });
    }
    if (problem) throw new Error('Push delivery failed');
    return later;
  }
  return {
    repository,
    config,
    alertRecipients,
    async testPush(adminId, endpoint) {
      if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY)
        return { status: 503, message: 'Push alerts are not configured yet.' };
      const sub = (await repository.subscriptions(adminId)).find(
        (s) => s.endpoint === endpoint,
      );
      if (!sub)
        return { status: 409, message: 'Enable push on this device first.' };
      try {
        await push.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify({
            title: 'Mado test alert',
            body: 'Push alerts are working on this device.',
            url: '/admin/notifications',
            tag: 'mado-push-test',
          }),
          {
            vapidDetails: vapid(),
            TTL: 300,
            timeout: 10000,
          },
        );
        return {
          status: 200,
          message:
            'Test sent to this device. Check your notifications. If nothing appears, check notification settings and Do Not Disturb.',
        };
      } catch (error) {
        if ([404, 410].includes(error.statusCode)) {
          await repository.deleteSubscription(endpoint, adminId);
          return {
            status: 409,
            message:
              'This device registration has expired. Enable push again, then retry.',
          };
        }
        return {
          status: 502,
          message: 'Unable to send the test alert. Please try again shortly.',
        };
      }
    },
    async schedule() {
      const now = clock(),
        state = await repository.context(now),
        prefs = state.settings.emails || {};
      for (const booking of state.bookings) {
        const client = state.clients.find((c) => c.id === booking.clientId);
        if (booking.status === 'confirmed' && booking.startAt > now) {
          const times = reminderTimes(
              booking,
              Number(prefs.reminderHours) || 48,
            ),
            startAt = booking.startAt.toISOString();
          for (const [template, time, enabled] of [
            ['reminder-48', times.first, true],
            [
              'reminder-morning',
              times.morning,
              prefs.morningReminder !== false,
            ],
          ]) {
            if (enabled && time >= booking.createdAt)
              await queue(
                template,
                { bookingId: booking.id, clientId: booking.clientId, startAt },
                `${template}:${booking.id}:${+booking.startAt}`,
                time,
                'reminder',
              );
          }
          // Covers owner-created bookings and verified manual transfers too.
          if (booking.updatedAt >= cutoff())
            await repository.notifyOnce(`confirmed:${booking.id}`, {
              type: 'booking_confirmed',
              title: 'A chair is booked',
              body: booking.ref,
              url: `/admin/bookings/${booking.id}`,
            });
        }
        if (booking.status === 'completed' && booking.completedAt >= cutoff()) {
          await queue(
            'thank-you',
            { bookingId: booking.id, clientId: booking.clientId },
            `thank-you:${booking.id}`,
            new Date(+booking.completedAt + 3 * 3600000),
          );
          if (
            prefs.winback === true &&
            marketingEligible(
              booking,
              client,
              state.bookings,
              now,
              state.clients,
              state.settings.clientLinks,
            )
          )
            for (const days of [30, 60, 90])
              await queue(
                `winback-${days}`,
                {
                  bookingId: booking.id,
                  clientId: booking.clientId,
                  styleSlug:
                    state.styles?.find((style) => style.id === booking.styleId)
                      ?.slug || '',
                },
                `winback:${booking.id}:${days}`,
                DateTime.fromJSDate(booking.completedAt, { zone: ZONE })
                  .plus({ days })
                  .toUTC()
                  .toJSDate(),
                'winback',
              );
        }
      }
      for (const review of (await repository.pendingReviews?.()) ?? []) {
        const left = +review.holdExpiresAt - +now;
        // After downtime only the most pressing reminder is sent.
        const hours = [1, 6].find((h) => left > 0 && left <= h * 3600000);
        const dueAt = +review.holdExpiresAt - hours * 3600000;
        if (hours && dueAt > +review.submittedAt)
          await repository.notifyOnce(
            `review-reminder:${review.proofId}:${hours}:${+review.holdExpiresAt}`,
            {
              type: 'payment_review_reminder',
              title: `Payment needs review within ${hours === 1 ? '1 hour' : `${hours} hours`}`,
              body: review.ref,
              url: `/admin/bookings/${review.bookingId}`,
            },
          );
      }
      for (const job of await repository.pending())
        if (!(await eligible(job, state))) {
          // Future reminders are valid even though they are not due yet.
          const detail = await repository.detail(job.payload.bookingId);
          if (
            job.type === 'reminder' &&
            detail?.booking.status === 'confirmed' &&
            detail.booking.startAt > now &&
            +new Date(job.payload.startAt) === +detail.booking.startAt &&
            job.runAt > now
          )
            continue;
          await repository.saveJob(job.id, { status: 'cancelled' });
        }
      for (const job of await repository.lifecycleJobs(cutoff())) {
        const p = job.payload;
        const kind = {
          'balance-receipt': 'balance_paid',
          'booking-cancelled': 'booking_cancelled',
          'booking-rescheduled': 'booking_rescheduled',
          'refund-receipt': 'refund_issued',
        }[p.template];
        if (kind && p.bookingId)
          await repository.notifyOnce(`${kind}:${job.id}`, {
            type: kind,
            title: kind.replace(/_/g, ' '),
            body: 'An appointment update is ready.',
            url: `/admin/bookings/${p.bookingId}`,
          });
      }
      const freshNotifications = (await repository.context(now)).notifications;
      for (const job of await repository.failedJobs())
        if (job.payload.template !== 'admin-alert')
          await repository.notifyOnce(`failed-job:${job.id}`, {
            type: 'delivery_failure',
            title: 'A background job needs attention',
            body: `Job ${job.id} has failed at least three attempts. Review the delivery/payment log.`,
            url: job.payload.bookingId
              ? `/admin/bookings/${job.payload.bookingId}`
              : '/admin/notifications',
          });
      await queueAlerts(freshNotifications, state, now);
      const local = DateTime.fromJSDate(now, { zone: ZONE });
      if (local.hour >= 7) {
        const agenda = state.bookings
          .filter(
            (b) =>
              b.status === 'confirmed' &&
              DateTime.fromJSDate(b.startAt, { zone: ZONE }).hasSame(
                local,
                'day',
              ),
          )
          .sort((a, b) => a.startAt - b.startAt)
          .map(
            (b) =>
              `${DateTime.fromJSDate(b.startAt, { zone: ZONE }).toFormat('h:mm a')} — ${state.clients.find((c) => c.id === b.clientId)?.name || 'Client'} — ${b.priceSnapshot.styleName} (${b.ref})`,
          )
          .join('\n');
        await queue('daily-agenda', { agenda }, `agenda:${local.toISODate()}`);
      }
      return state;
    },
    async run() {
      await this.schedule();
      const result = await this.deliver();
      await repository.cleanup(clock(), config.UPLOAD_DIR);
      return result;
    },
    // Right after something happens: owner alerts only. The timer does the rest.
    async deliverAlerts() {
      if (!repository.withLock) return false;
      return repository.withLock(async () => {
        const now = clock();
        const recent = await repository.recentNotifications(
          new Date(+now - 15 * 60000),
        );
        if (!recent.length) return;
        await queueAlerts(recent, await repository.context(now), now);
        await this.deliver(
          (job) =>
            job.type === 'push' ||
            (job.type === 'email' &&
              decode(job.payload).template === 'admin-alert'),
        );
      });
    },
    async deliver(only = () => true) {
      let sent = 0,
        failed = 0;
      const jobs = (await repository.due(clock(), cutoff())).filter(only);
      for (const job of jobs) {
        if (job.type === 'whatsapp' && !config.WHATSAPP_ALERTS_ENABLED)
          continue;
        if (!['push', 'whatsapp'].includes(job.type) && !config.EMAIL_ENABLED)
          continue;
        const state = await repository.context(clock());
        if (!(await eligible(job, state))) {
          await repository.saveJob(job.id, { status: 'cancelled' });
          continue;
        }
        const p = decode(job.payload);
        let whatsappProviderId;
        try {
          if (job.type === 'whatsapp') {
            const notification = await repository.notification(
              p.notificationId,
            );
            if (
              !notification ||
              notification.createdAt < new Date(config.WHATSAPP_ALERTS_START_AT)
            ) {
              await repository.saveJob(job.id, { status: 'cancelled' });
              continue;
            }
            const bookingId = Number(
              /^\/admin\/bookings\/(\d+)$/.exec(notification.url || '')?.[1],
            );
            const linked = state.bookings.find(
              (b) =>
                b.id === bookingId ||
                b.ref === notification.body?.split(':')[0],
            );
            let alert = notification;
            if (linked) {
              const detail = await repository.detail(linked.id);
              if (
                notification.type === 'booking_confirmed' &&
                detail?.booking.status !== 'confirmed'
              ) {
                await repository.saveJob(job.id, { status: 'cancelled' });
                continue;
              }
              if (detail?.client) {
                const visits = repository.completedVisitsBefore
                  ? await repository.completedVisitsBefore(detail.booking)
                  : 0;
                alert = {
                  ...notification,
                  whatsappText: whatsappBookingMessage(
                    detail,
                    visits,
                    notification.type === 'payment_review',
                  ),
                };
              }
            }
            // A process interruption must not automatically send the same alert twice.
            await repository.saveJob(job.id, { status: 'sending' });
            whatsappProviderId = await whatsapp.sendOwnerAlert(alert);
            sent++;
          } else if (job.type === 'push') {
            if (!config.VAPID_PRIVATE_KEY || !config.VAPID_PUBLIC_KEY) continue;
            const later = await sendPush(job, p, state);
            if (later) {
              await repository.saveJob(job.id, {
                status: 'pending',
                runAt: later,
              });
              continue;
            }
          } else {
            const detail = p.bookingId
              ? await repository.detail(p.bookingId)
              : null;
            let recipients = p.to
              ? [p.to]
              : [
                    'admin-alert',
                    'daily-agenda',
                    'contact-enquiry',
                    'owner-test',
                  ].includes(p.template)
                ? alertRecipients(state.settings)
                : [detail?.client.email];
            recipients = recipients.filter(Boolean);
            if (!recipients.length)
              throw new Error('No email recipient configured');
            const message = await renderEmail(
              config,
              p,
              detail,
              state.settings,
              await mailExtras(p, detail, state),
            );
            for (const recipient of recipients) {
              if (recipient.endsWith(REMOVED_DOMAIN)) continue;
              if (await repository.suppressed(recipient)) continue;
              const key = `job:${job.id}:${createHash('sha256').update(recipient.toLowerCase()).digest('hex')}`;
              let log = await repository.log(key);
              if (log && acceptedStatuses.has(log.status)) continue;
              if (log && ['sending', 'unknown'].includes(log.status)) {
                const error = new Error(
                  'Previous delivery needs verification before retry',
                );
                error.uncertain = true;
                throw error;
              }
              log ??= await repository.reserveLog({
                deliveryKey: key,
                bookingId: p.bookingId || null,
                clientId: detail?.client.id || null,
                template: p.template,
                toEmail: recipient,
                status: 'pending',
              });
              await repository.saveLog(log.id, { status: 'sending' });
              try {
                const providerId = await email.send(recipient, message, key);
                const latest = await repository.log(key);
                await repository.saveLog(log.id, {
                  providerId,
                  ...(acceptedStatuses.has(latest.status)
                    ? {}
                    : {
                        status:
                          config.EMAIL_PROVIDER === 'log' ? 'preview' : 'sent',
                      }),
                });
                sent++;
              } catch (error) {
                const delivered = await repository.log(key);
                if (acceptedStatuses.has(delivered?.status)) {
                  sent++;
                  continue;
                }
                await repository.saveLog(log.id, {
                  status: error.uncertain ? 'unknown' : 'failed',
                });
                throw error;
              }
            }
          }
          await repository.saveJob(job.id, {
            ...(whatsappProviderId
              ? { payload: { ...p, providerMessageId: whatsappProviderId } }
              : {}),
            status: 'done',
            attempts: job.attempts + 1,
            lastError: null,
          });
        } catch (error) {
          const failure = whatsappProviderId
            ? Object.assign(
                new Error(
                  'WhatsApp accepted the alert; verify provider records before retrying.',
                ),
                { uncertain: true },
              )
            : error;
          failed++;
          const attempts = failure.uncertain ? 5 : job.attempts + 1;
          await repository.saveJob(job.id, {
            status: 'failed',
            attempts,
            lastError: failure.message.slice(0, 300),
            runAt: new Date(
              +clock() + Math.min(24 * 60, 5 * 2 ** attempts) * 60000,
            ),
          });
          if (
            (attempts === 3 || failure.uncertain) &&
            p.template !== 'admin-alert'
          )
            await repository.notify({
              type:
                job.type === 'whatsapp' ? 'whatsapp_failure' : 'email_failure',
              title:
                job.type === 'whatsapp'
                  ? 'WhatsApp delivery needs attention'
                  : 'Email delivery needs attention',
              body: `Job ${job.id}: check provider records before retrying.`,
              url: '/admin/notifications',
            });
        }
      }
      return { sent, failed };
    },
    async unsubscribe(token) {
      const id = Number(token.split('.')[0]);
      if (!Number.isSafeInteger(id) || id < 1) return false;
      const client = await repository.client(id);
      if (!validUnsubscribe(token, client, config.SESSION_SECRET)) return false;
      await repository.unsubscribe(id);
      return true;
    },
    async queueContact(input) {
      await queue('contact-enquiry', input, `contact:${input.requestKey}`);
    },
    async queueReset(to, resetUrl) {
      await queue(
        'password-reset',
        {
          to,
          resetUrl,
          expiresAt: new Date(+clock() + 30 * 60000).toISOString(),
        },
        `reset:${resetUrl.split('#')[1]}`,
      );
    },
    async queueTest(admin, template = 'owner-test') {
      await queue(
        template,
        { to: admin.email },
        `test:${admin.id}:${Date.now()}`,
      );
    },
    unsubscribeToken: (client) =>
      unsubscribeToken(client, config.SESSION_SECRET),
  };
}
