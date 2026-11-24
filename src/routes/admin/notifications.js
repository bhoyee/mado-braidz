import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { emailTemplates } from '../../services/emailTemplates.js';
import { renderEmail } from '../../services/emailService.js';
import { accessToken, tokenHash } from '../../services/bookingService.js';
import rateLimit from 'express-rate-limit';
import { DateTime } from 'luxon';
import {
  ALERT_GROUPS,
  ALERT_VIEWS,
  alertPreferences,
  deviceName,
} from '../../services/alerts.js';
const ZONE = 'America/New_York';
const id = z.coerce.number().int().positive().safe();
const endpoint = z
  .url()
  .max(512)
  .refine((value) => {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      u.port === '' &&
      (u.hostname === 'fcm.googleapis.com' ||
        u.hostname.endsWith('.push.services.mozilla.com') ||
        u.hostname.endsWith('.notify.windows.com') ||
        u.hostname.endsWith('.push.apple.com'))
    );
  }, 'Unsupported push service');
function previewDetail(config) {
  const ref = 'MADO-0000000000000000';
  const start = new Date(Date.now() + 5 * 86400000);
  start.setUTCHours(15, 0, 0, 0);
  return {
    booking: {
      id: 1,
      clientId: 1,
      ref,
      styleId: 1,
      status: 'confirmed',
      paymentStatus: 'deposit_paid',
      source: 'web',
      createdAt: new Date(),
      startAt: start,
      endAt: new Date(+start + 4 * 3600000),
      subtotalCents: 18000,
      paidCents: 3000,
      balanceCents: 15000,
      clientNotes: '',
      holdExpiresAt: new Date(Date.now() + 86400000),
      manageTokenHash: tokenHash(accessToken(ref, config.SESSION_SECRET)),
      priceSnapshot: {
        styleName: 'Knotless Braids',
        size: 'medium',
        length: 'mid_back',
        addons: [],
        consultation: false,
        subtotalCents: 18000,
      },
    },
    client: {
      id: 1,
      name: 'Sample Client',
      email: 'sample@example.com',
      phoneE164: '+14437434979',
    },
  };
}
export function ownerNotifications(service) {
  const router = Router(),
    repo = service.repository;
  const run = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  router.get(
    '/api/notifications',
    run(async (req, res) =>
      res.json(
        await repo.notifications(
          res.locals.admin.id,
          z.coerce
            .number()
            .int()
            .min(0)
            .safe()
            .default(0)
            .parse(req.query.since),
        ),
      ),
    ),
  );
  router.get(
    '/notifications',
    run(async (req, res) => {
      const adminId = res.locals.admin.id;
      const { view, page } = z
        .object({
          view: z.enum(Object.keys(ALERT_VIEWS)).catch('all'),
          page: z.coerce.number().int().min(1).max(10000).catch(1),
        })
        .parse({ view: req.query.view || 'all', page: req.query.page || 1 });
      const [feed, needs, devices, state] = await Promise.all([
        repo.feed(adminId, { view, page }),
        repo.needsYou(),
        repo.subscriptions(adminId),
        repo.context(),
      ]);
      const days = [];
      const today = DateTime.now().setZone(ZONE);
      for (const item of feed.items) {
        const date = DateTime.fromJSDate(item.createdAt, { zone: ZONE });
        const label = date.hasSame(today, 'day')
          ? 'Today'
          : date.hasSame(today.minus({ days: 1 }), 'day')
            ? 'Yesterday'
            : date.toFormat('cccc, LLLL d, yyyy');
        if (days.at(-1)?.label !== label) days.push({ label, items: [] });
        days.at(-1).items.push({
          ...item,
          time: date.toFormat('h:mm a'),
          href: /^\/admin(?:\/|$)/.test(item.url || '')
            ? item.url
            : '/admin/notifications',
        });
      }
      res.render('admin/notifications', {
        ...feed,
        days,
        view,
        views: ALERT_VIEWS,
        needs,
        devices: devices.map(({ id, label, createdAt }) => ({
          id,
          label: label || 'Device',
          createdAt,
        })),
        groups: ALERT_GROUPS,
        prefs: alertPreferences(state.settings.alerts, adminId),
        pushAvailable: !!service.config.VAPID_PUBLIC_KEY,
        vapidKey: service.config.VAPID_PUBLIC_KEY,
      });
    }),
  );
  const answer = (req, res, message, extra = {}) =>
    req.accepts(['html', 'json']) === 'json'
      ? res.json({ url: '/admin/notifications', message, ...extra })
      : res.redirect(303, '/admin/notifications');
  router.post(
    '/notifications/read',
    run(async (req, res) => {
      const ids = await repo.markRead(
        res.locals.admin.id,
        req.body.id ? id.parse(req.body.id) : null,
      );
      answer(req, res, 'Notifications marked as read.', { ids });
    }),
  );
  router.post(
    '/notifications/unread',
    run(async (req, res) => {
      await repo.markUnread(
        res.locals.admin.id,
        z.array(id).max(5000).parse(req.body.ids),
      );
      answer(req, res, 'Marked as unread again.');
    }),
  );
  for (const [action, method, done, refused] of [
    [
      'retry',
      'retryFailure',
      'It will be sent again within five minutes.',
      'This cannot be sent again safely. Check with the client first.',
    ],
    [
      'dismiss',
      'dismissFailure',
      'Removed from the list.',
      'This is no longer on the list.',
    ],
  ])
    router.post(
      `/notifications/failures/:id/${action}`,
      run(async (req, res) => {
        if (await repo[method](id.parse(req.params.id)))
          return answer(req, res, done);
        res.status(409).json({ message: refused });
      }),
    );
  router.post(
    '/notifications/devices/:id/remove',
    run(async (req, res) => {
      await repo.removeDevice(id.parse(req.params.id), res.locals.admin.id);
      answer(req, res, 'That device no longer receives alerts.');
    }),
  );
  router.post(
    '/notifications/preferences',
    run(async (req, res) => {
      const on = (name) => ['on', 'true', true].includes(req.body[name]);
      const time = z
        .string()
        .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'Choose a time');
      const choices = (prefix) =>
        Object.fromEntries(
          ALERT_GROUPS.filter((group) => !group.locked).map((group) => [
            group.key,
            on(prefix + group.key),
          ]),
        );
      const times = z
        .object({ quietFrom: time, quietTo: time })
        .parse({ quietFrom: req.body.quietFrom, quietTo: req.body.quietTo });
      if (on('quiet') && times.quietFrom === times.quietTo)
        return res
          .status(400)
          .json({ message: 'Choose two different quiet-hour times.' });
      await repo.saveAlertPreferences(res.locals.admin.id, {
        email: choices('email_'),
        push: choices('push_'),
        names: on('names'),
        quiet: on('quiet'),
        ...times,
      });
      answer(req, res, 'Alert choices saved.');
    }),
  );
  router.post(
    '/api/push-subscriptions',
    run(async (req, res) => {
      if (!service.config.VAPID_PUBLIC_KEY)
        return res
          .status(503)
          .json({ message: 'Push alerts are not configured yet.' });
      const input = z
        .object({
          endpoint,
          keys: z.object({
            p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
            auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
          }),
        })
        .parse(req.body);
      await repo.saveSubscription(
        res.locals.admin.id,
        input,
        deviceName(req.get('user-agent')),
      );
      res.json({ message: 'Push alerts enabled on this device.' });
    }),
  );
  // Whether the server still knows this device.
  router.post(
    '/api/push-check',
    run(async (req, res) => {
      const wanted = endpoint.parse(req.body.endpoint);
      const known = (await repo.subscriptions(res.locals.admin.id)).some(
        (sub) => sub.endpoint === wanted,
      );
      res.json({ known });
    }),
  );
  router.delete(
    '/api/push-subscriptions',
    run(async (req, res) => {
      await repo.deleteSubscription(
        endpoint.parse(req.body.endpoint),
        res.locals.admin.id,
      );
      res.json({ message: 'Push alerts disabled on this device.' });
    }),
  );
  router.post(
    '/api/push-test',
    rateLimit({
      windowMs: 60000,
      limit: 3,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { message: 'Please wait a minute before sending another test.' },
    }),
    run(async (req, res) => {
      const result = await service.testPush(
        res.locals.admin.id,
        endpoint.parse(req.body.endpoint),
      );
      res.status(result.status).json({ message: result.message });
    }),
  );
  const wordingGroups = [
    ['Bookings', /^(booking|deposit)-/],
    ['Payments', /^(payment|balance|refund)-/],
    ['Reminders and follow-up', /^(reminder|thank|review|winback)/],
    ['Other', /./],
  ];
  // Owner-only messages keep their fixed wording.
  const fixedWording = new Set([
    'password-reset',
    'admin-alert',
    'daily-agenda',
    'contact-enquiry',
    'owner-test',
  ]);
  router.get(
    '/email-templates',
    run(async (req, res) => {
      const state = await repo.context();
      const saved = state.settings.emailTemplates || {};
      const groups = wordingGroups.map(([name]) => ({ name, items: [] }));
      for (const [key, value] of Object.entries(emailTemplates)) {
        if (fixedWording.has(key)) continue;
        const place = wordingGroups.findIndex(([, test]) => test.test(key));
        groups[place].items.push({
          key,
          ...value,
          ...saved[key],
          changed: Boolean(saved[key]),
        });
      }
      res.render('admin/email-templates', {
        groups: groups.filter((group) => group.items.length),
        emailEnabled:
          service.config.EMAIL_ENABLED &&
          service.config.EMAIL_PROVIDER !== 'log',
      });
    }),
  );
  const wording = z.object({
    template: z.enum(Object.keys(emailTemplates)),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .refine((v) => !/[\r\n]/.test(v)),
    intro: z.string().trim().min(1).max(1000),
  });
  // Sample details only. Opens in its own tab and cannot run scripts.
  router.post(
    '/email-templates/preview',
    run(async (req, res) => {
      const input = wording.parse(req.body);
      const state = await repo.context();
      const mail = await renderEmail(
        service.config,
        {
          template: input.template,
          bookingId: 1,
          method: 'zelle',
          paymentType: 'deposit',
          amountCents: 3000,
          styleSlug: '',
          url: '/admin',
        },
        previewDetail(service.config),
        {
          ...state.settings,
          emailTemplates: {
            ...state.settings.emailTemplates,
            [input.template]: { subject: input.subject, intro: input.intro },
          },
        },
        {},
      );
      res
        .set(
          'Content-Security-Policy',
          "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; sandbox allow-popups",
        )
        .type('html')
        .send(mail.html);
    }),
  );
  router.post(
    '/email-templates/reset',
    run(async (req, res) => {
      const key = z.enum(Object.keys(emailTemplates)).parse(req.body.template);
      const state = await repo.context();
      const saved = { ...state.settings.emailTemplates };
      delete saved[key];
      await repo.saveTemplates(saved, res.locals.admin.id);
      req.accepts(['html', 'json']) === 'json'
        ? res.json({
            url: '/admin/email-templates',
            message: 'Original wording restored.',
          })
        : res.redirect(303, '/admin/email-templates');
    }),
  );
  router.post(
    '/email-templates',
    run(async (req, res) => {
      const input = z
        .object({
          template: z.enum(Object.keys(emailTemplates)),
          subject: z
            .string()
            .trim()
            .min(1)
            .max(160)
            .refine((v) => !/[\r\n]/.test(v)),
          intro: z.string().trim().min(1).max(1000),
        })
        .parse(req.body);
      const state = await repo.context();
      await repo.saveTemplates(
        {
          ...state.settings.emailTemplates,
          [input.template]: { subject: input.subject, intro: input.intro },
        },
        res.locals.admin.id,
      );
      req.accepts(['html', 'json']) === 'json'
        ? res.json({
            url: '/admin/email-templates',
            message: 'Email wording saved.',
          })
        : res.redirect(303, '/admin/email-templates');
    }),
  );
  router.post(
    '/email-test',
    run(async (req, res) => {
      if (!service.config.EMAIL_ENABLED)
        return res.status(503).json({
          message: 'Enable verified email delivery before sending a test.',
        });
      await repo.queue({
        type: 'email',
        payload: { template: 'owner-test', to: res.locals.admin.email },
        dedupeKey: `owner-test:${randomUUID()}`,
        runAt: new Date(),
        status: 'pending',
      });
      res.json({
        url: '/admin/email-templates',
        message:
          'Test queued for your owner email. It will send on the next cron run.',
      });
    }),
  );
  return router;
}
// No private information. Phones ask for these without signing in, and cannot
// add the studio to the Home Screen otherwise.
export function ownerAppFiles() {
  const router = Router();
  const run = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res)).catch(next);
  router.get('/manifest.webmanifest', (_req, res) =>
    res.type('application/manifest+json').send({
      id: '/admin/',
      name: 'Mado Owner Studio',
      short_name: 'Mado Studio',
      start_url: '/admin/notifications',
      scope: '/admin/',
      display: 'standalone',
      background_color: '#fbf7f2',
      theme_color: '#1c0f26',
      icons: [
        { src: '/img/admin-icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/img/admin-icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
    }),
  );
  router.get(
    '/sw.js',
    run(async (_req, res) =>
      res
        .set({ 'Service-Worker-Allowed': '/admin/' })
        .type('application/javascript')
        .send(
          await readFile(
            new URL('../../client/admin-sw.js', import.meta.url),
            'utf8',
          ),
        ),
    ),
  );
  return router;
}
