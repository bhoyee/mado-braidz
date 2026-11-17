import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import {
  createBookingService,
  accessToken,
  tokenHash,
} from '../../services/bookingService.js';
import { BookingError } from '../../services/bookingErrors.js';
import { generateToken } from '../../middleware/csrf.js';
import { designAuth } from '../../middleware/designAuth.js';
import { payableBalance } from '../../services/paymentEligibility.js';
import {
  grantPaymentAccess,
  paymentToken,
  paymentPageUrl,
} from '../../services/paymentAccess.js';

export function manualMethods(config) {
  return [
    ...(config.ZELLE_RECIPIENT
      ? [{ id: 'zelle', name: 'Zelle', recipient: config.ZELLE_RECIPIENT }]
      : []),
    ...(config.CASHAPP_CASHTAG
      ? [{ id: 'cashapp', name: 'Cash App', recipient: config.CASHAPP_CASHTAG }]
      : []),
  ];
}
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2 },
}).single('proof');
const limited = (limit, windowMs = 3600000) =>
  rateLimit({
    limit,
    windowMs,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { message: 'Too many attempts. Please try again later.' },
  });
export function paymentPortal(repository, config, payments, catalog) {
  const router = Router();
  router.use((req, res, next) => {
    if (req.path.startsWith('/admin/payment-reviews'))
      res.set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      });
    next();
  });
  const service = createBookingService(
    repository,
    undefined,
    config.SESSION_SECRET,
  );
  const renderPay = (req, res, extra = {}) =>
    res
      .set({
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'Referrer-Policy': 'no-referrer',
      })
      .render('pages/pay', {
        title: 'Make a payment | Mado African Braidz',
        csrfToken: generateToken(req),
        manualMethods: manualMethods(config),
        paymentName: config.MANUAL_PAYMENT_NAME,
        hideMobileBooking: true,
        ...extra,
      });
  router.get('/pay', (req, res) => renderPay(req, res));
  router.post('/pay/search', limited(15), async (req, res, next) => {
    try {
      const input = z
        .object({
          query: z.string().trim().min(1).max(255),
          _csrf: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const query = input.query.trim();
      let kind, value;
      if (/^MADO-[A-F0-9]{16}$/i.test(query)) {
        kind = 'ref';
        value = query.toUpperCase();
      } else if (z.email().safeParse(query).success) {
        kind = 'email';
        value = query.toLowerCase();
      } else {
        const phone = parsePhoneNumberFromString(query, {
          defaultCountry: 'US',
          extract: false,
        });
        if (phone?.country === 'US' && phone.isValid()) {
          kind = 'phone';
          value = phone.number;
        }
      }
      const matches = kind ? await repository.paymentMatches(kind, value) : [];
      req.session.paySearch = kind ? { kind, value } : null;
      const found = [];
      for (const booking of matches) {
        const price =
          typeof booking.priceSnapshot === 'string'
            ? JSON.parse(booking.priceSnapshot)
            : booking.priceSnapshot;
        const initial =
          booking.status === 'pending_payment' &&
          booking.holdExpiresAt > new Date();
        const balance =
          ['confirmed', 'completed'].includes(booking.status) &&
          payableBalance(booking) &&
          booking.balanceCents > 0 &&
          !price.consultation;
        if (!initial && !balance) continue;
        const token = accessToken(booking.ref, config.SESSION_SECRET);
        if (tokenHash(token) !== booking.manageTokenHash) continue;
        found.push({
          ref: booking.ref,
          styleName: price.styleName,
          time: booking.startAt.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'long',
            timeStyle: 'short',
          }),
          amountCents: initial ? price.dueTodayCents : booking.balanceCents,
          kind: initial ? 'initial' : 'balance',
          pendingReview: (await repository.proofs(booking.id)).some(
            (proof) => proof.status === 'pending',
          ),
          url: grantPaymentAccess(req, booking.ref, token),
        });
      }
      req.session.paySelection = {
        items: found
          .filter((payment) => !payment.pendingReview)
          .map((payment) => ({
            ref: payment.ref,
            amountCents: payment.amountCents,
            kind: payment.kind,
          })),
        refs: found
          .filter((payment) => !payment.pendingReview)
          .map((payment) => payment.ref),
        batchId: 'batch-' + randomBytes(16).toString('hex'),
      };
      return renderPay(req, res, {
        query,
        found,
        totalDueCents: found.reduce(
          (total, payment) => total + payment.amountCents,
          0,
        ),
        payableCount: found.filter((payment) => !payment.pendingReview).length,
        payableTotalCents: found
          .filter((payment) => !payment.pendingReview)
          .reduce((sum, payment) => sum + payment.amountCents, 0),
        lookupMessage: found.length ? '' : 'No pending payments found.',
      });
    } catch (error) {
      next(error);
    }
  });
  async function batchAccess(req, id) {
    const batch = await repository.batch(id);
    if (!batch || !(req.session.paymentBatchAccess?.[id] > Date.now()))
      throw new BookingError(
        'NOT_FOUND',
        'Payment link expired. Search again.',
        404,
      );
    const items =
      typeof batch.items === 'string' ? JSON.parse(batch.items) : batch.items;
    for (const item of items)
      await payments.authorize(item.ref, paymentToken(req, item.ref));
    return { ...batch, items };
  }
  router.post('/api/pay/all', limited(10), async (req, res, next) => {
    try {
      z.object({})
        .strict()
        .parse(req.body || {});
      const selected = req.session.paySelection;
      if (!selected || !selected.items || selected.refs.length < 2)
        throw new BookingError(
          'INVALID_SELECTION',
          'Search for at least two pending payments.',
          409,
        );
      const tokens = Object.fromEntries(
        selected.refs.map((ref) => [ref, paymentToken(req, ref)]),
      );
      req.session.paymentBatchAccess ||= {};
      req.session.paymentBatchAccess[selected.batchId] = Date.now() + 3600000;
      res.json(
        await payments.checkoutBatch(
          selected.refs,
          tokens,
          selected.batchId,
          selected.items,
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  router.get('/pay/success', (req, res) => {
    const sessionId =
      typeof req.query.session_id === 'string' &&
      /^cs_[A-Za-z0-9_]+$/.test(req.query.session_id)
        ? req.query.session_id
        : '';
    res
      .set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' })
      .render('pages/batch-payment-result', {
        title: 'Your payments | Mado African Braidz',
        sessionId,
        csrfToken: generateToken(req),
        hideMobileBooking: true,
      });
  });
  router.get('/pay/batch/:id', async (req, res, next) => {
    try {
      const batch = await batchAccess(req, req.params.id);
      res
        .set({
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        })
        .render('pages/batch-payment-result', {
          title: 'Your payments | Mado African Braidz',
          sessionId: batch.stripeSessionId,
          batchId: batch.id,
          cancelRequested: req.query.cancel === '1',
          csrfToken: generateToken(req),
          hideMobileBooking: true,
        });
    } catch (error) {
      next(error);
    }
  });
  router.get(
    '/api/pay/batch-status',
    limited(120, 60000),
    async (req, res, next) => {
      try {
        const sessionId = z
          .string()
          .regex(/^cs_[A-Za-z0-9_]+$/)
          .parse(req.query.session_id);
        const initial = await repository.batchBySession(sessionId);
        if (!initial)
          throw new BookingError('NOT_FOUND', 'Payment not found.', 404);
        const batch = await batchAccess(req, initial.id);
        const entries = await Promise.all(
          batch.items.map(async (item) => {
            const row = await repository.bookingById(item.bookingId);
            const price =
              typeof row.priceSnapshot === 'string'
                ? JSON.parse(row.priceSnapshot)
                : row.priceSnapshot;
            return {
              ref: item.ref,
              styleName: price.styleName,
              startAt: row.startAt.toISOString(),
              status: row.status,
              paymentStatus: row.paymentStatus,
              amountCents: item.amountCents,
              refundedCents: item.refundedCents || 0,
              refundPending: Math.max(
                0,
                (item.refundDueCents || 0) - (item.refundedCents || 0),
              ),
              balanceCents: price.consultation ? null : row.balanceCents,
              url: paymentPageUrl(req, item.ref),
            };
          }),
        );
        res.set('Cache-Control', 'no-store').json({
          status: batch.status,
          totalCents: batch.totalCents,
          refundedCents: entries.reduce(
            (sum, item) => sum + item.refundedCents,
            0,
          ),
          entries,
        });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/api/pay/all/:id/cancel',
    limited(10),
    async (req, res, next) => {
      try {
        z.object({})
          .strict()
          .parse(req.body || {});
        const batch = await batchAccess(req, req.params.id);
        const result = await payments.cancelBatch(batch.id);
        res.json({
          url: result.paid
            ? '/pay/success?session_id=' + result.sessionId
            : '/pay',
        });
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/api/bookings/:ref/proof',
    limited(10),
    upload,
    async (req, res, next) => {
      let path;
      try {
        const ref = z
          .string()
          .regex(/^MADO-[A-F0-9]{16}$/)
          .parse(req.params.ref);
        const booking = await payments.authorize(ref, paymentToken(req, ref));
        const method = z.enum(['zelle', 'cashapp']).parse(req.body.method);
        if (!manualMethods(config).some((m) => m.id === method))
          throw new BookingError(
            'METHOD_UNAVAILABLE',
            'This payment method is not available.',
            409,
          );
        if (!req.file)
          throw new BookingError(
            'PROOF_REQUIRED',
            'Upload your payment screenshot.',
          );
        const b = req.file.buffer;
        if (!(
          (b[0] === 255 && b[1] === 216 && b[2] === 255) ||
          b
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (b.toString('ascii', 0, 4) === 'RIFF' &&
            b.toString('ascii', 8, 12) === 'WEBP')
        ))
          throw new BookingError(
            'INVALID_IMAGE',
            'Use a JPEG, PNG or WebP screenshot.',
          );
        const image = await sharp(b, { limitInputPixels: 40000000 })
          .rotate()
          .resize({
            width: 1800,
            height: 1800,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({ quality: 90 })
          .toBuffer()
          .catch(() => {
            throw new BookingError(
              'INVALID_IMAGE',
              'This screenshot could not be read. Choose a valid JPEG, PNG or WebP.',
            );
          });
        const filename = 'payment-' + randomBytes(24).toString('hex') + '.webp';
        await mkdir(config.UPLOAD_DIR, { recursive: true });
        path = join(config.UPLOAD_DIR, filename);
        await writeFile(path, image, { flag: 'wx', mode: 0o600 });
        await service.submitPaymentProof(
          booking.id,
          { method, path: filename },
          config.MANUAL_REVIEW_HOURS,
        );
        path = null;
        res.json({
          url: paymentPageUrl(req, ref),
          message: 'Payment proof submitted. Awaiting owner review.',
        });
      } catch (error) {
        if (path) await unlink(path).catch(() => {});
        next(error);
      }
    },
  );
  const owner = designAuth(catalog, 'Mado payment review');
  const ownerLimit = rateLimit({
    limit: 5,
    windowMs: 15 * 60000,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.get(
    '/admin/payment-reviews',
    ownerLimit,
    owner,
    async (req, res, next) => {
      try {
        const proofs = await repository.proofs();
        const rows = await Promise.all(
          proofs
            .filter((p) => p.status === 'pending')
            .map(async (p) => ({
              ...p,
              booking: await repository.bookingById(p.bookingId),
            })),
        );
        res.set('Cache-Control', 'no-store').render('pages/payment-reviews', {
          title: 'Payment reviews | Mado African Braidz',
          rows,
          csrfToken: generateToken(req),
          hideMobileBooking: true,
        });
      } catch (error) {
        next(error);
      }
    },
  );
  router.get(
    '/admin/payment-reviews/:id/image',
    ownerLimit,
    owner,
    async (req, res, next) => {
      try {
        const proof = await repository.proof(
          z.coerce.number().int().positive().parse(req.params.id),
        );
        if (!proof || !/^payment-[a-f0-9]{48}\.webp$/.test(proof.path))
          return res.sendStatus(404);
        res
          .set({
            'Cache-Control': 'no-store',
            'Content-Type': 'image/webp',
            'Content-Disposition': 'inline',
            'X-Content-Type-Options': 'nosniff',
          })
          .sendFile(resolve(config.UPLOAD_DIR, proof.path));
      } catch (error) {
        next(error);
      }
    },
  );
  router.post(
    '/admin/payment-reviews/:id',
    ownerLimit,
    owner,
    async (req, res, next) => {
      try {
        const id = z.coerce.number().int().positive().parse(req.params.id);
        const decision = z.enum(['approve', 'reject']).parse(req.body.decision);
        const note = z
          .string()
          .trim()
          .max(1000)
          .default('')
          .parse(req.body.note);
        await service.reviewPaymentProof(id, decision, res.locals.admin, note);
        res.redirect(303, '/admin/payment-reviews');
      } catch (error) {
        next(error);
      }
    },
  );
  router.use((error, req, res, next) => {
    if (error instanceof BookingError)
      return res
        .status(error.status)
        .json({ error: error.code, message: error.message });
    if (error instanceof z.ZodError || error instanceof multer.MulterError)
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message:
          'Check your details. Upload a JPEG, PNG or WebP screenshot up to 8 MB.',
      });
    next(error);
  });
  return router;
}
