import { Router } from 'express';
import { tokenHash } from '../../services/bookingService.js';
import { generateToken } from '../../middleware/csrf.js';
export function paymentPages(repository) {
  const router = Router();
  router.get('/book/success', (req, res, next) => {
    if (!repository) return next();
    const sessionId =
      typeof req.query.session_id === 'string' &&
      /^cs_[a-zA-Z0-9_]+$/.test(req.query.session_id)
        ? req.query.session_id
        : '';
    res
      .set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
      .render('pages/payment-result', {
        title: 'Your appointment | Mado African Braidz',
        sessionId,
      });
  });
  router.get('/booking/:token', async (req, res, next) => {
    try {
      if (!repository || !/^[a-f0-9]{64}$/.test(req.params.token))
        return next();
      const row = await repository.bookingByToken(tokenHash(req.params.token));
      if (!row) return next();
      req.session.bookingAccess ||= {};
      req.session.bookingAccess[row.ref] = req.params.token;
      const price =
        typeof row.priceSnapshot === 'string'
          ? JSON.parse(row.priceSnapshot)
          : row.priceSnapshot;
      res
        .set({
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          'Referrer-Policy': 'no-referrer',
        })
        .render('pages/manage-payment', {
          title: 'Your visit | Mado African Braidz',
          appointment: row,
          price,
          appointmentTime: row.startAt.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'long',
            timeStyle: 'short',
          }),
          csrfToken: generateToken(req),
          canPayBalance:
            ['confirmed', 'completed'].includes(row.status) &&
            row.paymentStatus === 'deposit_paid' &&
            row.balanceCents > 0 &&
            !price.consultation,
        });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
