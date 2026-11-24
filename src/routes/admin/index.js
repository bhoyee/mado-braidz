import { guideFor } from '../../config/guideVideos.js';
import { bookingPaymentSource } from '../../services/adminAppointment.js';
import {
  appointmentActions,
  appointmentHistory,
  appointmentVersion,
} from '../../services/adminAppointmentDetail.js';
import {
  calendarBlock,
  calendarBooking,
  money,
  phoneLabel,
  showOnCalendar,
  statusLabels,
} from '../../services/adminCalendar.js';
import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { createAdminAuthService } from '../../services/adminAuthService.js';
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
import { searchPortalPages } from '../../services/ownerSearch.js';

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
    res.locals.title = 'Owner studio | Mado African Braids';
    res.locals.currentPath = req.path;
    const today = DateTime.now().setZone(ZONE);
    res.locals.todayLabel = today.toFormat('cccc, LLLL d');
    res.locals.year = today.year;
    res.locals.guide = guideFor(
      req.path,
      req.query.tab,
      config.NODE_ENV === 'production',
    );
    next();
  });
  const renderAuth = (res, page, extra = {}) =>
    res.render('admin/auth', { page, ...extra });
  router.get(
    '/login',
    asyncRoute(async (_req, res) =>
      renderAuth(res, 'login', {
        showCode: Boolean(await admins.ownerTwoFactorEnabled?.()),
      }),
    ),
  );
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
        renderAuth(res.status(error.status), 'login', {
          error: error.message,
          showCode: Boolean(await admins.ownerTwoFactorEnabled?.()),
        });
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
  router.get(
    '/api/search',
    rateLimit({
      windowMs: 60000,
      limit: 90,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        res.status(429).json({ message: 'Try searching again shortly.' }),
    }),
    asyncRoute(async (req, res) => {
      const query = z.string().trim().min(2).max(120).parse(req.query.q);
      const pages = searchPortalPages(query);
      const groups = await admins.searchPortal(query);
      let remaining = 20;
      res.json({
        groups: [
          ...(pages.length ? [{ label: 'Pages', items: pages }] : []),
          ...groups,
        ]
          .map((group) => {
            const items = group.items.slice(0, Math.min(3, remaining));
            remaining -= items.length;
            return { ...group, items };
          })
          .filter((group) => group.items.length),
      });
    }),
  );
  if (notifications) router.use(ownerNotifications(notifications));
  router.get('/settings', (req, res, next) => {
    if (req.query.tab !== 'security') return next();
    res.render('admin/security', {
      enabled: Boolean(res.locals.admin.totpSecret),
    });
  });
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
  router.get('/security', (_req, res) =>
    res.redirect(303, '/admin/settings?tab=security'),
  );
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
  const viewNames = {
    today: 'Today',
    upcoming: 'Upcoming',
    review: 'Needs review',
    balance: 'Balance due',
    past: 'Past',
    cancelled: 'Cancelled',
    all: 'All',
  };
  function viewFilter(view) {
    const now = new Date();
    const today = DateTime.now().setZone(ZONE).startOf('day');
    return {
      today: {
        from: today.toJSDate(),
        to: today.plus({ days: 1 }).toJSDate(),
        statuses: [
          'pending_payment',
          'confirmed',
          'completed',
          'no_show',
          'payment_conflict',
        ],
        order: 'nearest',
      },
      upcoming: { from: today.toJSDate(), upcomingAt: now, order: 'nearest' },
      review: { reviewOnly: true, order: 'nearest' },
      balance: { balanceOnly: true, order: 'smart' },
      past: {
        to: now,
        statuses: ['confirmed', 'completed', 'no_show'],
        order: 'latest',
      },
      cancelled: {
        statuses: ['cancelled', 'expired', 'payment_conflict'],
        order: 'latest',
      },
      all: { order: 'smart' },
    }[view];
  }
  function filters(query, landing = 'all') {
    const input = z
      .object({
        search: z.string().trim().max(120).default(''),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        status: status.optional(),
        paymentStatus: paymentStatus.optional(),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        order: z.enum(['latest', 'nearest']).optional(),
        view: z.enum(Object.keys(viewNames)).optional(),
        live: z.enum(['true']).optional(),
        upcoming: z.enum(['true']).optional(),
      })
      .parse(
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== ''),
        ),
      );
    const narrowed =
      input.search ||
      input.from ||
      input.to ||
      input.status ||
      input.paymentStatus ||
      input.order ||
      input.live ||
      input.upcoming;
    const view = input.view || (narrowed ? 'all' : landing);
    const preset = viewFilter(view);
    const from = input.from
      ? DateTime.fromISO(input.from, { zone: ZONE }).toJSDate()
      : undefined;
    const to = input.to
      ? DateTime.fromISO(input.to, { zone: ZONE }).plus({ days: 1 }).toJSDate()
      : undefined;
    return {
      ...input,
      ...preset,
      view,
      // A chosen date range narrows the tab; it never widens it.
      from:
        from && preset.from
          ? from > preset.from
            ? from
            : preset.from
          : from || preset.from,
      to: to && preset.to ? (to < preset.to ? to : preset.to) : to || preset.to,
      order: input.order || preset.order,
      offset: (input.page - 1) * 25,
      liveAt: input.live === 'true' ? new Date() : undefined,
      upcomingAt: input.upcoming === 'true' ? new Date() : preset.upcomingAt,
    };
  }
  router.get(
    '/bookings',
    asyncRoute(async (req, res) => {
      const filter = filters(req.query, 'upcoming');
      const counted = ['today', 'upcoming', 'review', 'balance'];
      const [rows, total, ...counts] = await Promise.all([
        admins.list({ ...filter, limit: 25 }),
        admins.count(filter),
        ...counted.map((key) => admins.count(viewFilter(key))),
      ]);
      const query = new URLSearchParams(req.query);
      const link = (page) => {
        query.set('page', String(page));
        return '?' + query;
      };
      const exportQuery = new URLSearchParams(req.query);
      exportQuery.set('view', filter.view);
      exportQuery.delete('page');
      const view =
        filter.upcoming && !filter.search && !filter.status
          ? 'upcoming'
          : filter.view;
      res.render('admin/bookings', {
        rows,
        view,
        viewLabel:
          view === 'all'
            ? 'All appointments'
            : view === 'cancelled'
              ? 'Cancelled and expired'
              : viewNames[view],
        views: Object.entries(viewNames).map(([key, label]) => ({
          key,
          label,
          count: counts[counted.indexOf(key)],
        })),
        total,
        firstRow: Math.min(filter.offset + 1, total),
        lastRow: filter.offset + rows.length,
        hasNext: filter.offset + rows.length < total,
        previous: link(Math.max(1, filter.page - 1)),
        next: link(filter.page + 1),
        page: filter.page,
        filters: req.query,
        exportQuery: exportQuery.toString(),
      });
    }),
  );
  router.get(
    '/api/clients',
    rateLimit({
      windowMs: 60000,
      limit: 90,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
    asyncRoute(async (req, res) => {
      const query = z.string().trim().min(2).max(80).parse(req.query.q);
      const seen = new Set();
      const clients = [];
      for (const c of await admins.searchClients(query)) {
        const key = c.email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        clients.push({
          name: c.name,
          email: c.email,
          phone: c.phoneE164,
          phoneLabel: phoneLabel(c.phoneE164),
        });
        if (clients.length === 6) break;
      }
      res.json({ clients });
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
  router.get(
    '/calendar',
    asyncRoute(async (_req, res) => {
      const { settings } = await repository.catalog();
      res.render('admin/calendar', { hours: settings.hours.weekly });
    }),
  );
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
      const [rows, { timeBlocks }] = await Promise.all([
        admins.list({
          from: start.toJSDate(),
          to: end.toJSDate(),
          limit: 2000,
          order: 'nearest',
        }),
        repository.schedule(start.toJSDate(), end.toJSDate()),
      ]);
      const now = new Date();
      res.json([
        ...rows.filter((row) => showOnCalendar(row, now)).map(calendarBooking),
        ...timeBlocks.map(calendarBlock),
      ]);
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
    asyncRoute(async (req, res) => {
      const again = /^\d+$/.test(String(req.query.client || ''))
        ? await management?.people
            ?.summary(Number(req.query.client))
            .catch(() => null)
        : null;
      const client = again && !again.removed ? again : null;
      const last = client?.visits.find((visit) =>
        ['completed', 'confirmed'].includes(visit.status),
      );
      res.render('admin/edit', {
        isNew: true,
        catalog: await repository.catalog(),
        today: DateTime.now().setZone(ZONE).toISODate(),
        form: {
          name: client?.name,
          email: client?.email,
          phone: client?.phone,
          styleId: last?.styleId,
          styleVariantId: last?.styleVariantId,
          date:
            typeof req.query.date === 'string'
              ? req.query.date.slice(0, 10)
              : '',
          time: typeof req.query.time === 'string' ? req.query.time : '',
          notes: '',
          adminNotes: '',
        },
      });
    }),
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
      const booking = data.booking;
      const [proofs, attempts, jobs, visits, { settings }] = await Promise.all([
        repository.proofs(booking.id),
        repository.attempts(booking.id),
        repository.bookingJobs(booking.id),
        admins.clientVisits(data.client, booking.id),
        repository.catalog(),
      ]);
      const price = decode(booking.priceSnapshot);
      const refundJobs = jobs.filter((j) => j.type === 'refundConflict');
      const pendingProof = proofs.find((p) => p.status === 'pending');
      const actions = appointmentActions({
        booking,
        payments: data.payments,
        proofs,
        attempts,
        refundJobs,
        consultation: price.consultation,
      });
      const names = new Map();
      for (const adminId of new Set(data.audits.map((a) => a.adminId)))
        if (adminId)
          names.set(adminId, (await admins.adminById(adminId))?.name);
      const b = settings.business;
      res.render('admin/detail', {
        ...data,
        price,
        proofs,
        pendingProof,
        refundJobs,
        actions,
        visits,
        statusLabel:
          pendingProof && booking.status === 'pending_payment'
            ? 'Payment to review'
            : statusLabels[booking.status],
        openBooking: ['pending_payment', 'confirmed', 'completed'].includes(
          booking.status,
        ),
        paymentSource: bookingPaymentSource(booking, data.payments, proofs),
        history: appointmentHistory({
          ...data,
          proofs,
          money,
          adminName: (key) => names.get(key) || 'Owner',
          audits: data.audits.map((entry) => ({
            ...entry,
            changes: auditChanges(entry),
          })),
        }),
        version: appointmentVersion({ ...data, proofs, refundJobs, actions }),
        manageUrl: `${config.APP_URL.replace(/\/$/, '')}/booking/${accessToken(booking.ref, config.SESSION_SECRET)}`,
        directions:
          'https://www.google.com/maps/search/?api=1&query=' +
          encodeURIComponent(
            `${b.street}, ${b.city}, ${b.region} ${b.postalCode}`,
          ),
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
        {
          resend: 'Confirmation email on its way.',
          'balance-link': 'Balance link on its way.',
          payment: 'Payment recorded.',
          refund: 'Refund saved.',
          note: 'Note saved.',
          cancel: 'Appointment cancelled.',
          complete: 'Marked completed.',
          'no-show': 'Marked no-show.',
          confirm: 'Appointment confirmed.',
        }[input.action],
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
      const proofId = id.parse(req.params.id);
      const decision = z.enum(['approve', 'reject']).parse(req.body.decision);
      await bookings.reviewPaymentProof(
        proofId,
        decision,
        actor(req, res),
        text.parse(req.body.note),
      );
      const proof = await repository.proof(proofId);
      finish(
        req,
        res,
        req.body.from === 'booking'
          ? `/admin/bookings/${proof.bookingId}`
          : '/admin/payment-reviews',
        decision === 'approve' ? 'Payment approved.' : 'Payment rejected.',
      );
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
