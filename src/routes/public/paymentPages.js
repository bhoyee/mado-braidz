import { Router } from 'express';
import { tokenHash } from '../../services/bookingService.js';
import { generateToken } from '../../middleware/csrf.js';
import { paymentPortal, manualMethods } from './paymentPortal.js';
import { payableBalance } from '../../services/paymentEligibility.js';
export function paymentPages(repository, config, payments, catalog) {
  const router = Router();
  if (repository)
    router.use(paymentPortal(repository, config, payments, catalog));
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
        title: 'Your appointment | Mado African Braids',
        sessionId,
      });
  });
  async function renderVisit(req, res, row) {
    const price =
      typeof row.priceSnapshot === 'string'
        ? JSON.parse(row.priceSnapshot)
        : row.priceSnapshot;
    const proofs = await repository.proofs(row.id);
    const pendingProof = proofs.find((p) => p.status === 'pending');
    const options = (await catalog.load()).settings.balanceOptions || {};
    res
      .set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      })
      .render('pages/manage-payment', {
        title: 'Your visit | Mado African Braids',
        hideMobileBooking: true,
        appointment: row,
        price,
        pendingProof,
        balanceAfterReview: pendingProof
          ? Math.max(0, row.balanceCents - pendingProof.amountCents)
          : row.balanceCents,
        manualMethods: manualMethods(
          config,
          row.status === 'pending_payment' ? {} : options,
        ),
        balanceOptions: options,
        paymentName: config.MANUAL_PAYMENT_NAME,
        canSubmitProof:
          !pendingProof &&
          ((row.status === 'pending_payment' &&
            row.holdExpiresAt > new Date()) ||
            (['confirmed', 'completed'].includes(row.status) &&
              payableBalance(row) &&
              row.balanceCents > 0 &&
              !price.consultation)),
        initialPayment: row.status === 'pending_payment',
        appointmentTime: row.startAt.toLocaleString('en-US', {
          timeZone: 'America/New_York',
          dateStyle: 'long',
          timeStyle: 'short',
        }),
        csrfToken: generateToken(req),
        canPayBalance:
          options.online !== false &&
          !pendingProof &&
          ['confirmed', 'completed'].includes(row.status) &&
          payableBalance(row) &&
          row.balanceCents > 0 &&
          !price.consultation,
      });
  }
  router.get('/pay/appointment/:key', async (req, res, next) => {
    try {
      const grant = Object.entries(req.session.paymentAccess || {}).find(
        ([, value]) =>
          value.key === req.params.key && value.expiresAt > Date.now(),
      );
      if (!grant)
        return res
          .status(404)
          .send('Payment link expired. Search again on the Pay page.');
      const row = await repository.bookingByRef(grant[0]);
      if (!row || tokenHash(grant[1].token) !== row.manageTokenHash)
        return res.sendStatus(404);
      return await renderVisit(req, res, row);
    } catch (error) {
      next(error);
    }
  });
  router.get('/booking/:token', async (req, res, next) => {
    try {
      if (!repository || !/^[a-f0-9]{64}$/.test(req.params.token))
        return next();
      const row = await repository.bookingByToken(tokenHash(req.params.token));
      if (!row) return next();
      req.session.bookingAccess ||= {};
      req.session.bookingAccess[row.ref] = req.params.token;
      return await renderVisit(req, res, row);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
