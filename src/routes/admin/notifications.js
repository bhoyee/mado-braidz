import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { emailTemplates } from '../../services/emailTemplates.js';
import rateLimit from 'express-rate-limit';
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
        u.hostname.endsWith('.push.apple.com'))
    );
  }, 'Unsupported push service');
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
    run(async (req, res) =>
      res.render('admin/notifications', {
        ...(await repo.notifications(res.locals.admin.id)),
        pushAvailable: !!service.config.VAPID_PUBLIC_KEY,
        vapidKey: service.config.VAPID_PUBLIC_KEY,
        emailEnabled: service.config.EMAIL_ENABLED,
      }),
    ),
  );
  router.post(
    '/notifications/read',
    run(async (req, res) => {
      await repo.markRead(
        res.locals.admin.id,
        req.body.id ? id.parse(req.body.id) : null,
      );
      req.accepts(['html', 'json']) === 'json'
        ? res.json({
            url: '/admin/notifications',
            message: 'Notifications marked as read.',
          })
        : res.redirect(303, '/admin/notifications');
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
      await repo.saveSubscription(res.locals.admin.id, input);
      res.json({ message: 'Push alerts enabled on this device.' });
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
  router.get(
    '/email-templates',
    run(async (req, res) => {
      const state = await repo.context();
      res.render('admin/email-templates', {
        templates: Object.entries(emailTemplates).map(([key, value]) => ({
          key,
          ...value,
          ...state.settings.emailTemplates?.[key],
        })),
        emailEnabled: service.config.EMAIL_ENABLED,
        provider: service.config.EMAIL_PROVIDER,
      });
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
