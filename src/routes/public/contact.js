import { Router } from 'express';
import { z } from 'zod';
import { verifyTurnstile } from '../../services/turnstileService.js';
import { BookingError } from '../../services/bookingErrors.js';
import { generateToken } from '../../middleware/csrf.js';
import { randomUUID } from 'node:crypto';

// Message delivery stays disabled until the email milestone. Verification is
// already enforced on POST so enabling delivery later cannot bypass it.
export function contactRouter(config, notifications) {
  const router = Router();
  const render = (req, res, extra = {}) =>
    res.set('Cache-Control', 'no-store').render('pages/contact', {
      title: 'Contact the studio | Mado African Braidz',
      csrfToken: generateToken(req),
      ...extra,
    });
  router.get('/contact', (req, res) => render(req, res));
  router.post('/contact', async (req, res, next) => {
    try {
      const input = z
        .object({
          website: z.string().max(0).default(''),
          'cf-turnstile-response': z.string().max(2048).default(''),
        })
        .parse(req.body);
      await verifyTurnstile(
        config,
        input['cf-turnstile-response'],
        req.ip,
        'contact',
      );
      if (res.app.locals.contactEnabled && notifications) {
        const message = z
          .object({
            name: z.string().trim().min(2).max(100),
            email: z.email().max(255),
            message: z.string().trim().min(5).max(4000),
          })
          .parse(req.body);
        await notifications.queueContact({
          ...message,
          requestKey: randomUUID(),
        });
        return render(req, res, { contactSent: true });
      }
      return render(req, res.status(503), { contactUnavailable: true });
    } catch (error) {
      if (!(error instanceof BookingError) && !(error instanceof z.ZodError))
        return next(error);
      return render(req, res.status(error.status || 400), {
        contactError:
          error instanceof z.ZodError
            ? 'Unable to submit this form.'
            : error.message,
      });
    }
  });
  return router;
}
