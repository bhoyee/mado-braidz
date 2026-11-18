import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { rateLimit } from 'express-rate-limit';
import {
  createAdminAuthService,
  newTotpSecret,
} from '../../services/adminAuthService.js';
import {
  createBookingService,
  accessToken,
} from '../../services/bookingService.js';
import { BookingError } from '../../services/bookingErrors.js';
import { generateToken } from '../../middleware/csrf.js';
import { holdSchema } from '../public/booking.js';
import { daySlots, ZONE } from '../../services/availabilityService.js';
import { priceBooking } from '../../services/pricingService.js';
import { managementRouter } from './management.js';
import { ownerNotifications } from './notifications.js';

const id = z.coerce.number().int().positive().safe();
const cents = z.coerce.number().int().min(1).max(99999999);
const uuid = z.uuid();
const text = z.string().trim().max(2000).default('');
const contact = holdSchema.pick({ name: true, email: true, phone: true });
const selection = holdSchema.pick({
  styleId: true,
  styleVariantId: true,
  addonIds: true,
});
const password = z.string().min(12).max(128);
const bool = z.preprocess(
  (value) => value === true || value === 'on' || value === 'true',
  z.boolean(),
);
const status = z.enum([
  'pending_payment',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
  'expired',
  'payment_conflict',
]);
const paymentStatus = z.enum([
  'unpaid',
  'deposit_paid',
  'paid_in_full',
  'refunded',
  'partially_refunded',
]);
const method = z.enum(['cash', 'zelle', 'cashapp', 'card', 'other']);
const localStart = (date, time) => {
  const parsed = DateTime.fromISO(`${date}T${time}`, { zone: ZONE });
  if (
    !parsed.isValid ||
    parsed.toFormat('yyyy-MM-dd HH:mm') !== `${date} ${time}`
  )
    throw new BookingError('INVALID_START', 'Choose a valid date and time.');
  return parsed.toUTC().toISO();
};
export function adminRouter(
  admins,
  repository,
  config,
  payments,
  _catalog,
  management,
  notifications,
) {
  const router = Router();
  const auth = createAdminAuthService(
    admins,
    config,
    undefined,
    notifications ? (to, url) => notifications.queueReset(to, url) : null,
  );
  const bookings = createBookingService(
    repository,
    undefined,
    config.SESSION_SECRET,
  );
  const asyncRoute = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
  });
  router.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    });
    if (config.NODE_ENV === 'production' && !req.secure)
      return res.status(403).send('HTTPS is required');
    res.locals.csrfToken = generateToken(req);
    res.locals.requestKey = randomUUID();
    res.locals.title = 'Owner studio | Mado African Braidz';
    res.locals.currentPath = req.path;
    next();
  });
  const renderAuth = (res, page, extra = {}) =>
    res.render('admin/auth', { page, ...extra });
  router.get('/login', (_req, res) => renderAuth(res, 'login'));
  router.post(
    '/login',
    authLimit,
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          email: z.email().max(255),
          password: z.string().min(1).max(128),
          code: z.string().max(6).default(''),
        })
        .parse(req.body);
      try {
        const grant = await auth.login(
          input.email,
          input.password,
          input.code,
          req.ip,
        );
        await new Promise((done, reject) =>
          req.session.regenerate((error) => (error ? reject(error) : done())),
        );
        req.session.owner = { ...grant, expiresAt: Date.now() + 8 * 3600000 };
        await new Promise((done, reject) =>
          req.session.save((error) => (error ? reject(error) : done())),
        );
        res.redirect(303, '/admin');
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        renderAuth(res.status(error.status), 'login', { error: error.message });
      }
    }),
  );
  router.get('/forgot', (_req, res) => renderAuth(res, 'forgot'));
  router.post(
    '/forgot',
    authLimit,
    asyncRoute(async (req, res) => {
      const email = z.email().max(255).parse(req.body.email);
      try {
        await auth.requestReset(email, req.ip);
      } catch {
        req.log.warn('Owner password reset delivery unavailable');
      }
      renderAuth(res, 'forgot', {
        message:
          'If this is the owner email, a reset link has been requested. Check your inbox.',
      });
    }),
  );
  router.get('/reset', (_req, res) => renderAuth(res, 'reset'));
  router.post(
    '/reset',
    authLimit,
    asyncRoute(async (req, res) => {
      const input = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/), password })
        .parse(req.body);
      try {
        await auth.resetPassword(input.token, input.password, req.ip);
        req.session.destroy(() => {});
        res.redirect(303, '/admin/login');
      } catch (error) {
        if (!(error instanceof BookingError)) throw error;
        renderAuth(res.status(error.status), 'reset', { error: error.message });
      }
    }),
  );
  router.use(
    asyncRoute(async (req, res, next) => {
      const admin = await auth.authenticate(req.session.owner);
      if (!admin) {
        if (
          req.path.startsWith('/api/') ||
          req.accepts(['html', 'json']) === 'json'
        )
          return res
            .status(401)
            .json({ message: 'Sign in to continue.', url: '/admin/login' });
        return res.redirect(303, '/admin/login');
      }
      res.locals.admin = admin;
      next();
    }),
  );
  const actor = (req, res) => ({ ...res.locals.admin, ip: req.ip });
  if (notifications) router.use(ownerNotifications(notifications));
  if (management) router.use(managementRouter(management, config));
  const finish = (req, res, url, message) =>
    req.accepts(['html', 'json']) === 'json'
      ? res.json({ url, message })
      : res.redirect(303, url);
  router.post('/logout', (req, res, next) =>
    req.session.destroy((error) =>
      error
        ? next(error)
        : res.clearCookie('mado.sid').redirect(303, '/admin/login'),
    ),
  );
  router.get('/security', (req, res) => {
    if (!res.locals.admin.totpSecret) req.session.totpSetup ||= newTotpSecret();
    res.render('admin/security', {
      secret: req.session.totpSetup,
      enabled: Boolean(res.locals.admin.totpSecret),
    });
  });
  router.post(
    '/security',
    authLimit,
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          action: z.enum(['password', 'enable', 'disable']),
          password: z.string().max(128),
          code: z.string().max(6).default(''),
          newPassword: password.optional(),
        })
        .parse(req.body);
      if (input.action === 'password') password.parse(input.newPassword);
      if (input.action === 'enable' && !req.session.totpSetup)
        throw new BookingError(
          'INVALID_CODE',
          'Reload the security page to start setup.',
        );
      await auth.changeSecurity(
        res.locals.admin.id,
        input.password,
        { ...input, secret: req.session.totpSetup },
        req.ip,
      );
      req.session.destroy(() => {});
      finish(req, res, '/admin/login', 'Security updated. Sign in again.');
    }),
  );
  router.get(
    '/',
    asyncRoute(async (req, res) => {
      const now = DateTime.now().setZone(ZONE),
        today = now.startOf('day');
      const [appointments, metrics] = await Promise.all([
        admins.list({
          from: today.toJSDate(),
          upcomingAt: now.toJSDate(),
          order: 'nearest',
          limit: null,
        }),
        admins.metrics(
          now.startOf('week').toJSDate(),
          now.startOf('month').toJSDate(),
          now.toJSDate(),
          today.toJSDate(),
        ),
      ]);
      res.render('admin/dashboard', {
        appointments,
        metrics,
        today: today.toISODate(),
      });
    }),
  );
  router.get(
    '/payments',
    asyncRoute(async (req, res) => {
      const period = z
        .enum(['week', 'month'])
        .default('week')
        .parse(req.query.period);
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .default(1)
        .parse(req.query.page);
      const now = DateTime.now().setZone(ZONE),
        from = now.startOf(period);
      const [rows, metrics] = await Promise.all([
        admins.receipts({
          from: from.toJSDate(),
          to: now.toJSDate(),
          offset: (page - 1) * 100,
          limit: 101,
        }),
        admins.metrics(
          now.startOf('week').toJSDate(),
          now.startOf('month').toJSDate(),
          now.toJSDate(),
          now.startOf('day').toJSDate(),
        ),
      ]);
      res.render('admin/financial', {
        mode: 'receipts',
        title: period === 'week' ? 'Received this week' : 'Received this month',
        period,
        rows: rows.slice(0, 100),
        total: metrics[period],
        page,
        hasNext: rows.length > 100,
        range:
          from.toFormat('LLL d, yyyy') + ' – ' + now.toFormat('LLL d, yyyy'),
        previous: '?period=' + period + '&page=' + (page - 1),
        next: '?period=' + period + '&page=' + (page + 1),
      });
    }),
  );
  router.get(
    '/balances',
    asyncRoute(async (req, res) => {
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .default(1)
        .parse(req.query.page);
      const now = DateTime.now().setZone(ZONE);
      const [rows, metrics] = await Promise.all([
        admins.list({
          balanceOnly: true,
          order: 'nearest',
          offset: (page - 1) * 100,
          limit: 101,
        }),
        admins.metrics(
          now.startOf('week').toJSDate(),
          now.startOf('month').toJSDate(),
          now.toJSDate(),
          now.startOf('day').toJSDate(),
        ),
      ]);
      res.render('admin/financial', {
        mode: 'balances',
        title: 'Balances outstanding',
        rows: rows.slice(0, 100),
        total: metrics.owed,
        page,
        hasNext: rows.length > 100,
        range: 'Confirmed and completed appointments with a balance to pay',
        previous: '?page=' + (page - 1),
        next: '?page=' + (page + 1),
      });
    }),
  );
  function filters(query) {
    const input = z
      .object({
        search: z.string().trim().max(120).default(''),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        status: status.optional(),
        paymentStatus: paymentStatus.optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        order: z.enum(['latest', 'nearest']).default('latest'),
        live: z.enum(['true']).optional(),
        upcoming: z.enum(['true']).optional(),
      })
      .parse(
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== ''),
        ),
      );
    return {
      ...input,
      from: input.from
        ? DateTime.fromISO(input.from, { zone: ZONE }).toJSDate()
        : undefined,
      to: input.to
        ? DateTime.fromISO(input.to, { zone: ZONE })
            .plus({ days: 1 })
            .toJSDate()
        : undefined,
      offset: (input.page - 1) * 100,
      liveAt: input.live === 'true' ? new Date() : undefined,
      upcomingAt: input.upcoming === 'true' ? new Date() : undefined,
    };
  }
  router.get(
    '/bookings',
    asyncRoute(async (req, res) => {
      const filter = filters(req.query);
      const rows = await admins.list({ ...filter, limit: 101 });
      const query = new URLSearchParams(req.query);
      query.set('page', String(Math.max(1, filter.page - 1)));
      const previous = '?' + query;
      query.set('page', String(filter.page + 1));
      res.render('admin/bookings', {
        rows: rows.slice(0, 100),
        hasNext: rows.length > 100,
        previous,
        next: '?' + query,
        page: filter.page,
        filters: req.query,
        exportQuery: new URLSearchParams(req.query).toString(),
      });
    }),
  );
  router.get(
    '/bookings/export',
    asyncRoute(async (req, res) => {
      const filter = filters(req.query);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mado-bookings.csv"',
      });
      const cell = (value) =>
        '"' +
        String(value ?? '')
          .replace(/^[=+\-@\t\r]/, (c) => "'" + c)
          .replaceAll('"', '""') +
        '"';
      res.write(
        'Reference,Client,Email,Phone,Start Eastern,Status,Total USD,Paid USD,Balance USD\r\n',
      );
      for (let offset = 0; ; offset += 1000) {
        const rows = await admins.list({ ...filter, offset, limit: 1000 });
        for (const { booking: b, client: c } of rows)
          res.write(
            [
              b.ref,
              c.name,
              c.email,
              c.phoneE164,
              DateTime.fromJSDate(b.startAt, { zone: ZONE }).toFormat(
                'yyyy-MM-dd HH:mm',
              ),
              b.status,
              (b.subtotalCents / 100).toFixed(2),
              (b.paidCents / 100).toFixed(2),
              (b.balanceCents / 100).toFixed(2),
            ]
              .map(cell)
              .join(',') + '\r\n',
          );
        if (rows.length < 1000) break;
      }
      res.end();
    }),
  );
  router.get('/calendar', (_req, res) => res.render('admin/calendar'));
  router.get(
    '/audit',
    asyncRoute(async (req, res) => {
      const page = z.coerce
        .number()
        .int()
        .min(1)
        .max(100000)
        .default(1)
        .parse(req.query.page);
      const rows = await admins.auditList((page - 1) * 100);
      res.render('admin/audit', {
        rows: rows
          .slice(0, 100)
          .map((row) => ({ ...row, changes: auditChanges(row.entry) })),
        page,
        hasNext: rows.length > 100,
      });
    }),
  );
  router.post(
    '/api/quote',
    asyncRoute(async (req, res) => {
      const input = selection.parse(req.body);
      res.json(
        priceBooking(await repository.catalog(), {
          ...input,
          paymentChoice: 'deposit',
        }),
      );
    }),
  );
  router.get(
    '/api/calendar',
    asyncRoute(async (req, res) => {
      const start = DateTime.fromISO(z.string().parse(req.query.start)),
        end = DateTime.fromISO(z.string().parse(req.query.end));
      if (
        !start.isValid ||
        !end.isValid ||
        end <= start ||
        end.diff(start, 'days').days > 62
      )
        throw new BookingError(
          'INVALID_RANGE',
          'Choose a calendar range of 62 days or less.',
        );
      const rows = await admins.list({
        from: start.toJSDate(),
        to: end.toJSDate(),
        limit: 2000,
      });
      res.json(
        rows
          .filter(
            ({ booking: b }) =>
              b.status !== 'pending_payment' || b.holdExpiresAt > new Date(),
          )
          .map(({ booking: b, client: c }) => ({
            id: b.id,
            title: `${c.name} · ${decode(b.priceSnapshot).styleName}`,
            start: b.startAt.toISOString(),
            end: b.endAt.toISOString(),
            url: `/admin/bookings/${b.id}`,
            editable: ['confirmed', 'pending_payment'].includes(b.status),
            classNames: [`status-${b.status}`],
            extendedProps: {
              status: b.status,
              updatedAt: b.updatedAt.toISOString(),
            },
          })),
      );
    }),
  );
  router.post(
    '/api/bookings/:id/move',
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          startAt: z.iso.datetime({ offset: true }),
          expectedUpdatedAt: z.iso.datetime({ offset: true }),
          notifyClient: z.boolean(),
          requestKey: uuid,
        })
        .parse(req.body);
      const row = await admins.detail(id.parse(req.params.id));
      if (!row) throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
      await bookings.adminEdit(
        row.booking.id,
        {
          ...input,
          name: row.client.name,
          email: row.client.email,
          phone: row.client.phoneE164,
          notes: row.booking.clientNotes,
          adminNotes: row.booking.adminNotes,
        },
        actor(req, res),
      );
      res.json({ saved: true });
    }),
  );
  router.get(
    '/api/slots',
    asyncRoute(async (req, res) => {
      const date = z.iso.date().parse(req.query.date),
        bookingId = req.query.bookingId ? id.parse(req.query.bookingId) : null;
      let durationMin;
      if (bookingId && !req.query.durationMin) {
        const row = await repository.bookingById(bookingId);
        if (!row)
          throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
        durationMin = decode(row.priceSnapshot).durationMin;
      } else
        durationMin = z.coerce
          .number()
          .int()
          .min(1)
          .max(900)
          .parse(req.query.durationMin);
      const data = await repository.catalog(),
        settings = structuredClone(data.settings);
      settings.booking.minNoticeHours = 0;
      settings.booking.maxAdvanceDays = 3650;
      const start = DateTime.fromISO(date, { zone: ZONE });
      const schedule = await repository.schedule(
        start.toJSDate(),
        start.plus({ days: 1 }).toJSDate(),
      );
      res.json(
        daySlots({
          date,
          durationMin,
          settings,
          ...schedule,
          bookings: schedule.bookings.filter((b) => b.id !== bookingId),
        }),
      );
    }),
  );
  router.get(
    '/bookings/new',
    asyncRoute(async (req, res) =>
      res.render('admin/edit', {
        isNew: true,
        catalog: await repository.catalog(),
        form: {
          date:
            typeof req.query.date === 'string'
              ? req.query.date.slice(0, 10)
              : '',
          time: typeof req.query.time === 'string' ? req.query.time : '',
          notes: '',
          adminNotes: '',
        },
      }),
    ),
  );
  router.post(
    '/bookings/new',
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          ...contact.shape,
          ...selection.shape,
          date: z.iso.date(),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          notes: text,
          mode: z.enum(['link', 'manual', 'override']),
          amountCents: cents.optional(),
          method: method.default('cash'),
          requestKey: uuid,
        })
        .parse(blankOptional(req.body));
      const result = await bookings.createHold(
        {
          ...input,
          startAt: localStart(input.date, input.time),
          checkoutRequestKey: input.requestKey,
          paymentChoice: 'deposit',
          marketingConsent: false,
        },
        null,
        { ...input, admin: actor(req, res) },
      );
      finish(req, res, `/admin/bookings/${result.id}`, 'Appointment created.');
    }),
  );
  router.get(
    '/bookings/:id',
    asyncRoute(async (req, res) => {
      const data = await admins.detail(id.parse(req.params.id));
      if (!data) throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
      res.render('admin/detail', {
        ...data,
        audits: data.audits.map((entry) => ({
          ...entry,
          changes: auditChanges(entry),
        })),
        price: decode(data.booking.priceSnapshot),
        manageUrl: `${config.APP_URL.replace(/\/$/, '')}/booking/${accessToken(data.booking.ref, config.SESSION_SECRET)}`,
        refundJobs: (await repository.bookingJobs(data.booking.id)).filter(
          (j) => j.type === 'refundConflict',
        ),
        proofs: await repository.proofs(data.booking.id),
      });
    }),
  );
  router.get(
    '/bookings/:id/edit',
    asyncRoute(async (req, res) => {
      const data = await admins.detail(id.parse(req.params.id));
      if (!data) throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
      const local = DateTime.fromJSDate(data.booking.startAt, { zone: ZONE });
      res.render('admin/edit', {
        ...data,
        catalog: await repository.catalog(),
        price: decode(data.booking.priceSnapshot),
        form: {
          ...data.client,
          phone: data.client.phoneE164,
          date: local.toISODate(),
          time: local.toFormat('HH:mm'),
          notes: data.booking.clientNotes,
          adminNotes: data.booking.adminNotes,
        },
      });
    }),
  );
  router.post(
    '/bookings/:id/edit',
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          ...contact.shape,
          ...selection.partial().shape,
          date: z.iso.date(),
          time: z.string().regex(/^\d{2}:\d{2}$/),
          notes: text,
          adminNotes: text,
          changeStyle: bool,
          notifyClient: bool,
          quotedTotalCents: cents.optional(),
          expectedUpdatedAt: z.iso.datetime({ offset: true }),
          requestKey: uuid,
        })
        .parse(blankOptional(req.body));
      if (input.changeStyle) selection.parse(input);
      const bookingId = id.parse(req.params.id);
      await bookings.adminEdit(
        bookingId,
        { ...input, startAt: localStart(input.date, input.time) },
        actor(req, res),
      );
      finish(req, res, `/admin/bookings/${bookingId}`, 'Appointment updated.');
    }),
  );
  router.post(
    '/bookings/:id/action',
    asyncRoute(async (req, res) => {
      const input = z
        .object({
          action: z.enum([
            'confirm',
            'cancel',
            'complete',
            'no-show',
            'payment',
            'refund',
            'note',
            'balance-link',
            'resend',
          ]),
          amountCents: cents.optional(),
          method: method.optional(),
          paymentId: id.optional(),
          note: text,
          requestKey: uuid,
        })
        .parse(blankOptional(req.body));
      if (['payment', 'refund'].includes(input.action))
        cents.parse(input.amountCents);
      if (input.action === 'payment') method.parse(input.method);
      if (input.action === 'refund') id.parse(input.paymentId);
      const bookingId = id.parse(req.params.id);
      await bookings.adminAction(bookingId, input, actor(req, res));
      if (input.action === 'refund') {
        try {
          await payments?.runRefunds(bookingId);
        } catch {
          req.log.warn('Owner refund queued for retry');
        }
      }
      finish(
        req,
        res,
        `/admin/bookings/${bookingId}`,
        ['resend', 'balance-link'].includes(input.action)
          ? 'Email queued. Delivery is enabled in Milestone 7.'
          : 'Booking updated.',
      );
    }),
  );
  router.get(
    '/bookings/:id/inspiration',
    asyncRoute(async (req, res) => {
      const data = await admins.detail(id.parse(req.params.id));
      const path = data?.inspiration?.path;
      if (!path || !/^[a-f0-9]{40}\.webp$/.test(path))
        return res.sendStatus(404);
      res.type('webp').sendFile(resolve(config.UPLOAD_DIR, path));
    }),
  );
  router.get(
    '/payment-reviews',
    asyncRoute(async (_req, res) => {
      const proofs = (await repository.proofs()).filter(
        (p) => p.status === 'pending',
      );
      const rows = await Promise.all(
        proofs.map(async (p) => ({
          ...p,
          booking: await repository.bookingById(p.bookingId),
        })),
      );
      res.render('admin/reviews', { rows });
    }),
  );
  router.get(
    '/payment-reviews/:id/image',
    asyncRoute(async (req, res) => {
      const proof = await repository.proof(id.parse(req.params.id));
      if (!proof || !/^payment-[a-f0-9]{48}\.webp$/.test(proof.path))
        return res.sendStatus(404);
      res.type('webp').sendFile(resolve(config.UPLOAD_DIR, proof.path));
    }),
  );
  router.post(
    '/payment-reviews/:id',
    asyncRoute(async (req, res) => {
      await bookings.reviewPaymentProof(
        id.parse(req.params.id),
        z.enum(['approve', 'reject']).parse(req.body.decision),
        actor(req, res),
        text.parse(req.body.note),
      );
      finish(req, res, '/admin/payment-reviews', 'Payment review saved.');
    }),
  );
  router.use((error, req, res, next) => {
    if (!(error instanceof BookingError) && !(error instanceof z.ZodError))
      return next(error);
    const message =
      error instanceof z.ZodError
        ? error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .slice(0, 3)
            .join(' · ')
        : error.message;
    if (
      req.accepts(['html', 'json']) === 'json' ||
      req.path.startsWith('/api/')
    )
      return res
        .status(error.status || 400)
        .json({ message, error: error.code || 'INVALID_INPUT' });
    res.status(error.status || 400).render('admin/error', { error: message });
  });
  return router;
}
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
function blankOptional(body) {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([key, value]) =>
        value !== '' ||
        ![
          'amountCents',
          'paymentId',
          'styleVariantId',
          'quotedTotalCents',
          'newPassword',
        ].includes(key),
    ),
  );
}
function auditChanges(entry) {
  const before = decode(entry.before) || {},
    after = decode(entry.after) || {};
  if (entry.entity !== 'booking') {
    const flatten = (value, prefix = '') =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          if (
            /password|secret|token|key/i.test(key) ||
            ['updatedAt', 'createdAt'].includes(key)
          )
            return [];
          const path = prefix + key;
          return item && typeof item === 'object' && !Array.isArray(item)
            ? Object.entries(flatten(item, path + '.'))
            : [[path, item]];
        }),
      );
    const a = flatten(before),
      b = flatten(after),
      keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    const display = (value) =>
      value == null
        ? '—'
        : typeof value === 'object'
          ? JSON.stringify(value).slice(0, 300)
          : typeof value === 'boolean'
            ? value
              ? 'Yes'
              : 'No'
            : String(value);
    return keys
      .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
      .map((key) => ({
        label: key
          .replace(/^value\./, '')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replaceAll('.', ' · '),
        before: display(a[key]),
        after: display(b[key]),
      }));
  }
  const fields = [
    ['Start time', before.startAt, after.startAt, 'date'],
    ['End time', before.endAt, after.endAt, 'date'],
    ['Status', before.status, after.status],
    ['Total', before.subtotalCents, after.subtotalCents, 'money'],
    ['Paid', before.paidCents, after.paidCents, 'money'],
    ['Balance', before.balanceCents, after.balanceCents, 'money'],
    ['Client', before.client?.name, after.client?.name],
    ['Email', before.client?.email, after.client?.email],
    ['Phone', before.client?.phoneE164, after.client?.phoneE164],
    ['Client notes', before.clientNotes, after.clientNotes],
    ['Private notes', before.adminNotes, after.adminNotes],
    ['Requested amount', null, after.operation?.amountCents, 'money'],
    ['Reason / note', null, after.operation?.note],
  ];
  const format = (value, kind) =>
    value === undefined || value === null || value === ''
      ? '—'
      : kind === 'date'
        ? DateTime.fromJSDate(new Date(value), { zone: ZONE }).toFormat(
            'LLL d, yyyy · h:mm a',
          ) + ' ET'
        : kind === 'money'
          ? new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
            }).format(value / 100)
          : String(value).replaceAll('_', ' ');
  return fields
    .filter(([, a, b]) => String(a ?? '') !== String(b ?? ''))
    .map(([label, a, b, kind]) => ({
      label,
      before: format(a, kind),
      after: format(b, kind),
    }));
}
