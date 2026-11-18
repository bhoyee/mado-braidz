import { Router } from 'express';
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const token = z.string().regex(/^\d{1,16}\.[a-f0-9]{64}$/);
export function emailPublicRoutes(service) {
  const router = Router();
  router.post(
    '/webhooks/brevo',
    express.json({ limit: '64kb' }),
    async (req, res) => {
      const secret = service.config.BREVO_WEBHOOK_SECRET;
      if (!secret) return res.sendStatus(503);
      const hash = (value) => createHash('sha256').update(value).digest();
      if (
        !timingSafeEqual(
          hash(req.get('X-Mado-Webhook-Secret') || ''),
          hash(secret),
        )
      )
        return res.sendStatus(401);
      const parsed = z
        .object({
          event: z.enum([
            'request',
            'blocked',
            'delivered',
            'hard_bounce',
            'soft_bounce',
            'spam',
            'unsubscribed',
            'invalid_email',
            'deferred',
          ]),
          email: z.email(),
          'message-id': z.string().min(1).max(255),
          'X-Mailin-custom': z.string().max(512).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.sendStatus(400);
      try {
        const data = parsed.data;
        const kind = {
          request: 'sent',
          delivered: 'delivered',
          hard_bounce: 'bounced',
          soft_bounce: 'deferred',
          spam: 'complained',
          unsubscribed: 'unsubscribed',
          blocked: 'blocked',
          invalid_email: 'bounced',
          deferred: 'deferred',
        }[data.event];
        await service.repository.delivery({
          kind,
          providerId: data['message-id'].replace(/^<|>$/g, ''),
          recipient: data.email,
          deliveryKey:
            data['X-Mailin-custom']?.match(/^deliveryKey:(.+)$/)?.[1],
          suppress: [
            'hard_bounce',
            'spam',
            'unsubscribed',
            'invalid_email',
          ].includes(data.event),
        });
        res.json({ received: true });
      } catch {
        res.sendStatus(503);
      }
    },
  );
  router.post(
    '/unsubscribe/:token',
    express.urlencoded({ extended: false, limit: '2kb' }),
    async (req, res, next) => {
      try {
        const parsed = token.safeParse(req.params.token);
        if (!parsed.success || !(await service.unsubscribe(parsed.data)))
          return res.status(400).send('Invalid unsubscribe link');
        res.set('Cache-Control', 'no-store');
        if (req.body['List-Unsubscribe'] === 'One-Click')
          return res
            .type('text/plain')
            .send(
              'You are unsubscribed from salon news. Appointment emails continue.',
            );
        res.render('pages/email-preferences', { unsubscribed: true });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get('/unsubscribe/:token', async (req, res, next) => {
    try {
      const parsed = token.safeParse(req.params.token);
      if (!parsed.success) return res.sendStatus(404);
      res
        .set({
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Robots-Tag': 'noindex',
        })
        .render('pages/email-preferences', { unsubscribed: false });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
