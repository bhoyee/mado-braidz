import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import multer from 'multer';
import sharp from 'sharp';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { priceBooking } from '../../services/pricingService.js';
import { createAvailabilityService } from '../../services/availabilityService.js';
import { createBookingService } from '../../services/bookingService.js';
import { BookingError } from '../../services/bookingErrors.js';
import { createHash } from 'node:crypto';

const id = z.coerce.number().int().positive().safe();
const addonIds = z
  .preprocess(
    (value) =>
      typeof value === 'string' ? (value ? value.split(',') : []) : value,
    z.array(id).max(20),
  )
  .default([]);
export const selectionSchema = z
  .object({
    styleId: id.optional(),
    styleVariantId: id.optional(),
    addonIds,
    paymentChoice: z.enum(['deposit', 'full']).default('deposit'),
  })
  .strict();
export const holdSchema = selectionSchema
  .extend({
    styleId: id,
    startAt: z.iso.datetime({ offset: true }),
    name: z.string().trim().min(2).max(120),
    email: z
      .email()
      .max(255)
      .transform((v) => v.toLowerCase()),
    phone: z
      .string()
      .trim()
      .transform((value) => {
        const clean = value.replace(/[\s().-]/g, '');
        if (!/^\+?\d+$/.test(clean)) return null;
        const phone = parsePhoneNumberFromString(clean, {
          defaultCountry: 'US',
          extract: false,
        });
        return phone?.country === 'US' && phone.isValid() ? phone.number : null;
      })
      .refine((value) => value !== null, 'Invalid phone number'),
    notes: z.string().trim().max(2000).default(''),
    policyAccepted: z.literal(true),
    marketingConsent: z.boolean().default(false),
    website: z.string().max(0).default(''),
    turnstileToken: z.string().max(2048).default(''),
    requestKey: z.uuid().optional(),
  })
  .strict();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 1, fieldSize: 32768 },
}).single('inspiration');

export function bookingRouter(repository, config, payments) {
  const router = Router();
  router.use((req, res, next) =>
    repository
      ? next()
      : res.status(503).json({
          error: 'BOOKING_UNAVAILABLE',
          message: 'Please call the studio to arrange a visit.',
        }),
  );
  const availability = repository && createAvailabilityService(repository);
  const booking =
    repository &&
    createBookingService(repository, undefined, config.SESSION_SECRET);
  async function selection(raw) {
    const input = selectionSchema.parse(raw);
    if (!input.styleId && input.styleVariantId) {
      const catalog = await repository.catalog();
      input.styleId = catalog.styles.find((s) =>
        s.variants.some((v) => v.id === input.styleVariantId),
      )?.id;
    }
    if (!input.styleId)
      throw new BookingError('INVALID_STYLE', 'Choose a style.');
    return input;
  }
  const run = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (e) {
      next(e);
    }
  };
  router.get(
    '/availability/day',
    run(async (req, res) => {
      const { date, ...raw } = req.query;
      const parsed = z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .parse(date);
      res
        .set('Cache-Control', 'no-store')
        .json(await availability.day(await selection(raw), parsed));
    }),
  );
  router.get(
    '/availability',
    run(async (req, res) => {
      const { month, ...raw } = req.query;
      const parsed = z
        .string()
        .regex(/^\d{4}-\d{2}$/)
        .parse(month);
      const first = DateTime.fromISO(parsed + '-01');
      if (!first.isValid || first.toFormat('yyyy-MM') !== parsed)
        throw new BookingError('INVALID_DATE', 'Choose a valid month.');
      res
        .set('Cache-Control', 'no-store')
        .json(await availability.month(await selection(raw), parsed));
    }),
  );
  router.get(
    '/bookings/quote',
    run(async (req, res) =>
      res
        .set('Cache-Control', 'no-store')
        .json(
          priceBooking(await repository.catalog(), await selection(req.query)),
        ),
    ),
  );
  router.post(
    '/bookings/hold',
    upload,
    run(async (req, res) => {
      let path;
      try {
        let raw = req.body;
        if (req.is('multipart/form-data')) {
          try {
            raw = JSON.parse(req.body.payload);
          } catch {
            throw new BookingError(
              'INVALID_INPUT',
              'Check your booking details.',
            );
          }
        }
        const input = holdSchema.parse(raw);
        if (input.requestKey)
          input.checkoutRequestKey = createHash('sha256')
            .update(req.sessionID + ':' + input.requestKey)
            .digest('hex');
        if (config.TURNSTILE_SECRET_KEY) {
          let verification;
          try {
            const response = await fetch(
              'https://challenges.cloudflare.com/turnstile/v0/siteverify',
              {
                method: 'POST',
                body: new URLSearchParams({
                  secret: config.TURNSTILE_SECRET_KEY,
                  response: input.turnstileToken,
                  remoteip: req.ip,
                }),
                signal: AbortSignal.timeout(10000),
              },
            );
            verification = await response.json();
          } catch {
            throw new BookingError(
              'VERIFICATION_UNAVAILABLE',
              'Verification is temporarily unavailable. Please try again.',
              503,
            );
          }
          if (!verification.success)
            throw new BookingError(
              'VERIFICATION_FAILED',
              'Please complete the security check and try again.',
            );
        }
        let media = null;
        if (req.file) {
          // Check bytes; never trust file extension or browser MIME type.
          const b = req.file.buffer;
          const image =
            (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) ||
            b
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
            (b.toString('ascii', 0, 4) === 'RIFF' &&
              b.toString('ascii', 8, 12) === 'WEBP');
          if (!image)
            throw new BookingError(
              'INVALID_IMAGE',
              'Use a JPEG, PNG or WebP inspiration image.',
            );
          let output;
          try {
            output = await sharp(b, { limitInputPixels: 40000000 })
              .rotate()
              .resize({
                width: 1600,
                height: 1600,
                fit: 'inside',
                withoutEnlargement: true,
              })
              .webp({ quality: 85 })
              .toBuffer({ resolveWithObject: true });
          } catch {
            throw new BookingError(
              'INVALID_IMAGE',
              'This image could not be read. Use a smaller JPEG, PNG or WebP image.',
            );
          }
          await mkdir(config.UPLOAD_DIR, { recursive: true });
          const filename = randomBytes(20).toString('hex') + '.webp';
          path = join(config.UPLOAD_DIR, filename);
          await writeFile(path, output.data, { flag: 'wx', mode: 0o600 });
          media = {
            kind: 'inspiration',
            path: filename,
            width: output.info.width,
            height: output.info.height,
            alt: 'Private booking inspiration supplied by the client',
          };
        }
        const result = await booking.createHold(input, media);
        if (result.reused && path) {
          await unlink(path).catch(() => {});
          path = null;
        }
        req.session.bookingAccess ||= {};
        req.session.bookingAccess[result.ref] = result.manageToken;
        delete result.manageToken;
        req.session.lastHold = {
          ref: result.ref,
          holdExpiresAt: result.holdExpiresAt,
        };
        res.status(201).set('Cache-Control', 'no-store').json(result);
      } catch (e) {
        if (path) await unlink(path).catch(() => {});
        throw e;
      }
    }),
  );
  const refSchema = z.string().regex(/^MADO-[A-F0-9]{16}$/);
  const empty = z.object({}).strict();
  for (const action of ['checkout', 'balance', 'cancel'])
    router.post(
      `/bookings/:ref/${action}`,
      run(async (req, res) => {
        const ref = refSchema.parse(req.params.ref);
        empty.parse(req.body || {});
        const token = req.session.bookingAccess?.[ref];
        if (!payments)
          throw new BookingError(
            'PAYMENT_UNAVAILABLE',
            'Online payment is unavailable.',
            503,
          );
        const result =
          action === 'cancel'
            ? await payments.cancel(ref, token)
            : await payments.checkout(ref, token, action === 'balance');
        res.set('Cache-Control', 'no-store').json(result);
      }),
    );
  router.get(
    '/bookings/payment-status',
    run(async (req, res) => {
      const sessionId = z
        .string()
        .regex(/^cs_[a-zA-Z0-9_]+$/)
        .parse(req.query.session_id);
      const attempt = await repository.attemptBySession?.(sessionId);
      const row = attempt && (await repository.bookingById(attempt.bookingId));
      if (!row || !payments)
        throw new BookingError('NOT_FOUND', 'Payment not found.', 404);
      res
        .set('Cache-Control', 'no-store')
        .json(
          await payments.status(
            sessionId,
            req.session.bookingAccess?.[row.ref],
          ),
        );
    }),
  );
  router.get(
    '/bookings/:ref/status',
    run(async (req, res) => {
      const ref = refSchema.parse(req.params.ref);
      const row = await payments.authorize(
        ref,
        req.session.bookingAccess?.[ref],
      );
      const attempts = await repository.attempts(row.id);
      const attempt = attempts.filter((a) => a.stripeSessionId).at(-1);
      res
        .set('Cache-Control', 'no-store')
        .json(
          attempt
            ? await payments.status(
                attempt.stripeSessionId,
                req.session.bookingAccess[ref],
              )
            : { ref, status: row.status, paymentStatus: row.paymentStatus },
        );
    }),
  );
  router.use((err, req, res, next) => {
    if (err instanceof z.ZodError)
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: err.issues.some((issue) => issue.path[0] === 'phone')
          ? 'Invalid phone number'
          : 'Check required fields',
        fields: err.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    if (err instanceof BookingError)
      return res
        .status(err.status)
        .json({ error: err.code, message: err.message, ...err.details });
    if (err instanceof multer.MulterError)
      return res.status(400).json({
        error: 'INVALID_UPLOAD',
        message: 'Use one image up to 8 MB.',
      });
    next(err);
  });
  return router;
}
