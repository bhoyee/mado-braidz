import { Router } from 'express';
import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
const token = z.string().regex(/^\d{1,16}\.[a-f0-9]{64}$/);
export function emailPublicRoutes(service) {
  const router = Router();
  router.post(
    '/webhooks/postmark',
    express.json({ limit: '64kb' }),
    async (req, res) => {
      const secret = service.config.POSTMARK_WEBHOOK_SECRET;
      if (!secret) return res.sendStatus(503);
      const expected =
        'Basic ' + Buffer.from(`postmark:${secret}`).toString('base64');
      const hash = (value) => createHash('sha256').update(value).digest();
      if (
        !timingSafeEqual(hash(req.get('Authorization') || ''), hash(expected))
      )
        return res.sendStatus(401);
      const parsed = z
        .object({
          RecordType: z.enum([
            'Delivery',
            'Bounce',
            'SpamComplaint',
            'SubscriptionChange',
          ]),
          MessageID: z.string().max(255).nullable().optional(),
          Recipient: z.email().optional(),
          Email: z.email().optional(),
          Inactive: z.boolean().optional(),
          SuppressSending: z.boolean().optional(),
          MessageStream: z.string().max(255).optional(),
          SuppressionReason: z.string().max(100).nullable().optional(),
          Metadata: z
            .object({ deliveryKey: z.string().max(255).optional() })
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return res.sendStatus(400);
      try {
        await service.repository.delivery(parsed.data);
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
