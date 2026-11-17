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
          bookingCode: z.string().trim().max(32).optional(),
          _csrf: z.string().optional(),
        })
        .strict()
        .parse(req.body);
      const query = input.query.trim();
      const code = (
        /^MADO-/i.test(query) ? query : input.bookingCode || ''
      ).toUpperCase();
      if (!code)
        return renderPay(req, res, {
          lookupMessage:
            'Enter your booking confirmation code to securely view payments linked to this phone or email.',
          query,
        });
      const booking = /^MADO-[A-F0-9]{16}$/.test(code)
        ? await repository.bookingByRef(code)
        : null;
      let match = !!booking;
      if (booking && !/^MADO-/i.test(query)) {
        const client = await repository.client(booking.clientId);
        const phone = parsePhoneNumberFromString(query, 'US');
        match =
          query.toLowerCase() === client.email.toLowerCase() ||
          (phone?.isValid() &&
            phone.country === 'US' &&
            phone.number === client.phoneE164);
      }
      if (!match)
        return renderPay(req, res, {
          lookupMessage: 'No pending payments found.',
          query,
        });
      const price =
        typeof booking.priceSnapshot === 'string'
          ? JSON.parse(booking.priceSnapshot)
          : booking.priceSnapshot;
      const initial =
        booking.status === 'pending_payment' &&
        booking.holdExpiresAt > new Date();
      const balance =
        ['confirmed', 'completed'].includes(booking.status) &&
        booking.paymentStatus === 'deposit_paid' &&
        booking.balanceCents > 0 &&
        !price.consultation;
      if (!initial && !balance)
        return renderPay(req, res, {
          lookupMessage: 'No pending payments found.',
          query,
        });
      const token = accessToken(booking.ref, config.SESSION_SECRET);
      if (tokenHash(token) !== booking.manageTokenHash)
        return renderPay(req, res, {
          lookupMessage:
            'Please use your original booking link or call the studio.',
          query,
        });
      req.session.bookingAccess ||= {};
      req.session.bookingAccess[booking.ref] = token;
      return renderPay(req, res, {
        query,
        found: {
          ref: booking.ref,
          styleName: price.styleName,
          time: booking.startAt.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            dateStyle: 'long',
            timeStyle: 'short',
          }),
          amountCents: initial ? price.dueTodayCents : booking.balanceCents,
          url: '/booking/' + token,
        },
      });
    } catch (error) {
      next(error);
    }
  });
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
        const booking = await payments.authorize(
          ref,
          req.session.bookingAccess?.[ref],
        );
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
          url: '/booking/' + req.session.bookingAccess[ref],
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
