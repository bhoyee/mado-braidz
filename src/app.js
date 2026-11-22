import { paymentPages } from './routes/public/paymentPages.js';
import { manualMethods } from './routes/public/paymentPortal.js';
import {
  createStripeProvider,
  createPaymentService,
} from './services/paymentService.js';
import { stripeWebhook } from './routes/webhooks/stripe.js';
import { bookingRouter } from './routes/public/booking.js';
import { createBookingRepository } from './services/bookingRepository.js';
import { join, resolve } from 'node:path';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { createDatabase } from './db/index.js';
import { createCatalogService } from './services/catalogService.js';
import { publicRouter, money } from './routes/public/index.js';
import { designRouter } from './routes/admin/design.js';
import { adminRouter } from './routes/admin/index.js';
import { createAdminRepository } from './services/adminRepository.js';
import { createManagementService } from './services/managementService.js';
import { contactRouter } from './routes/public/contact.js';
import { createNotificationRepository } from './services/notificationRepository.js';
import { createNotificationService } from './services/notificationService.js';
import { emailPublicRoutes } from './routes/public/emailPreferences.js';
import { DateTime } from 'luxon';
import { randomBytes } from 'node:crypto';
import express from 'express';
import nunjucks from 'nunjucks';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import mysqlSession from 'express-mysql-session';
import pinoHttp from 'pino-http';
import { fileURLToPath } from 'node:url';
import { parseEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
import { createRateLimits } from './middleware/rateLimit.js';
import {
  csrfSynchronisedProtection,
  invalidCsrfTokenError,
} from './middleware/csrf.js';
export function createApp({
  config = parseEnv(),
  sessionStore,
  bookingRepository,
  adminRepository,
  managementService,
  notificationService,
  stripeProvider,
  catalog,
  logger = createLogger(config),
} = {}) {
  const app = express();
  app.locals.whatsappUrl = config.WHATSAPP_NUMBER
    ? `https://wa.me/${config.WHATSAPP_NUMBER.replace(/\D/g, '')}?text=${encodeURIComponent('Hi Mado, I have a question about booking a hairstyle.')}`
    : '';
  app.set('trust proxy', 1);
  app.set('env', config.NODE_ENV);
  let database;
  catalog ??= createCatalogService(
    (database = createDatabase(config.DATABASE_URL)).db,
  );
  bookingRepository ??= database ? createBookingRepository(database.db) : null;
  adminRepository ??= database ? createAdminRepository(database.db) : null;
  managementService ??= database ? createManagementService(database.db) : null;
  notificationService ??= database
    ? createNotificationService(
        createNotificationRepository(database.db),
        config,
      )
    : null;
  app.locals.contactEnabled = Boolean(
    notificationService &&
    config.EMAIL_ENABLED &&
    (config.ADMIN_ALERT_EMAILS || config.ADMIN_EMAIL),
  );
  app.locals.ownerPortal = Boolean(adminRepository);
  const provider =
    stripeProvider === undefined
      ? createStripeProvider(config)
      : stripeProvider;
  const payments = bookingRepository
    ? createPaymentService(bookingRepository, provider, config)
    : null;
  app.locals.paymentsEnabled = Boolean(provider);
  app.locals.manualMethods = manualMethods(config);
  app.locals.paymentName = config.MANUAL_PAYMENT_NAME;
  app.locals.closeDatabase = () => database?.pool.end();
  app.locals.turnstileSiteKey = config.TURNSTILE_ENABLED
    ? config.TURNSTILE_SITE_KEY
    : '';
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          const safe = { ...req };
          if (safe.url)
            safe.url = safe.url
              .replace(/(\/booking\/)[a-f0-9]{64}/g, '$1[redacted]')
              .replace(/(\/unsubscribe\/)\d+\.[a-f0-9]{64}/g, '$1[redacted]')
              .replace(/(session_id=)[^&]+/g, '$1[redacted]');
          return safe;
        },
      },
    }),
  );
  app.use((_req, res, next) => {
    res.locals.cspNonce = randomBytes(18).toString('base64');
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          styleSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
          imgSrc: [
            "'self'",
            'data:',
            (req) => (req.path.startsWith('/admin') ? 'blob:' : "'self'"),
          ],
          frameSrc: [
            "'self'",
            'https://maps.google.com',
            'https://www.google.com',
            'https://challenges.cloudflare.com',
          ],
          connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
          fontSrc: [
            "'self'",
            (req) => (req.path.startsWith('/admin') ? 'data:' : "'self'"),
          ],
          mediaSrc: [
            "'self'",
            (req) => (req.path.startsWith('/admin') ? 'blob:' : "'self'"),
          ],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
        },
      },
      hsts: config.NODE_ENV === 'production' ? undefined : false,
    }),
  );
  app.use(compression());
  // Email clients embed this public logo from outside the website origin.
  app.get('/img/email-logo.png', (_req, res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.sendFile(
      fileURLToPath(new URL('../public/img/email-logo.png', import.meta.url)),
      { maxAge: '7d' },
    );
  });
  // Browsers also request this conventional fallback independently of page links.
  app.get('/favicon.ico', (_req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(
      fileURLToPath(new URL('../public/img/favicon-mado.ico', import.meta.url)),
    );
  });
  const releaseFile = new URL('../release.json', import.meta.url);
  const revision = existsSync(releaseFile)
    ? JSON.parse(readFileSync(releaseFile, 'utf8')).revision
    : undefined;
  app.get('/health', (_req, res) =>
    res.set('Cache-Control', 'no-store').json({ status: 'ok', revision }),
  );
  app.use(
    '/build',
    express.static(fileURLToPath(new URL('../public/build', import.meta.url))),
  );
  for (const dir of ['fonts', 'img', 'media'])
    app.use(
      `/${dir}`,
      express.static(
        fileURLToPath(new URL(`../public/${dir}`, import.meta.url)),
        { maxAge: '7d' },
      ),
    );
  app.use(
    '/webhooks/stripe',
    stripeWebhook(provider, payments, config, notificationService),
  );
  if (notificationService) app.use(emailPublicRoutes(notificationService));
  app.use(express.json({ limit: '32kb' }));
  app.use(express.urlencoded({ extended: false, limit: '32kb' }));
  if (!sessionStore && config.NODE_ENV !== 'test') {
    const Store = mysqlSession(session);
    const url = new URL(config.DATABASE_URL);
    sessionStore = new Store({
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.slice(1),
      createDatabaseTable: false,
    });
  }
  app.use(
    session({
      name: 'mado.sid',
      store: sessionStore,
      secret: config.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );
  const limits = createRateLimits();
  app.use('/api/bookings/hold', limits.hold);
  app.use(
    [
      '/api/bookings/:ref/checkout',
      '/api/bookings/:ref/balance',
      '/api/bookings/:ref/cancel',
    ],
    limits.checkout,
  );
  app.use('/api/bookings/payment-status', limits.availability);
  app.post('/contact', limits.contact);
  app.use('/api/availability', limits.availability);
  app.use(csrfSynchronisedProtection);
  const views = nunjucks.configure(
    fileURLToPath(new URL('./views', import.meta.url)),
    {
      autoescape: true,
      express: app,
      noCache: config.NODE_ENV !== 'production',
    },
  );
  views.addFilter('money', money);
  views.addFilter('et', (value, format = 'ccc, LLL d · h:mm a') =>
    value
      ? DateTime.fromJSDate(new Date(value), {
          zone: 'America/New_York',
        }).toFormat(format)
      : '—',
  );
  // Versioned media URLs: the file's modified time is appended, so browsers
  // fetch a regenerated clip or poster instead of replaying a cached copy.
  const mediaDir = fileURLToPath(new URL('../public/media', import.meta.url));
  views.addGlobal('media', (file) => {
    const safe = String(file).replace(/[^a-z0-9._-]/gi, '');
    try {
      const version = Math.floor(
        statSync(join(mediaDir, safe)).mtimeMs,
      ).toString(36);
      return `/media/${safe}?v=${version}`;
    } catch {
      return `/media/${safe}`;
    }
  });
  app.set('view engine', 'njk');
  if (adminRepository && bookingRepository)
    app.use(
      '/admin',
      adminRouter(
        adminRepository,
        bookingRepository,
        config,
        payments,
        catalog,
        managementService,
        notificationService,
      ),
    );
  app.use('/admin', designRouter(catalog, limits.preview));
  app.get('/media/videos/:file', (req, res) => {
    if (!/^[a-f0-9-]{36}\.mp4$/.test(req.params.file))
      return res.sendStatus(404);
    res.type('video/mp4');
    res.sendFile(
      req.params.file,
      {
        root: resolve(config.UPLOAD_DIR, 'videos'),
        maxAge: '1y',
        immutable: true,
        dotfiles: 'deny',
      },
      (error) => {
        if (error && !res.headersSent) res.sendStatus(404);
      },
    );
  });
  app.get('/media/catalog/:file', (req, res) => {
    if (!/^[a-f0-9-]{36}-(480|960|1600)\.(webp|avif)$/.test(req.params.file))
      return res.sendStatus(404);
    res.sendFile(
      req.params.file,
      {
        root: resolve(config.UPLOAD_DIR, 'catalog'),
        maxAge: '1y',
        immutable: true,
        dotfiles: 'deny',
      },
      (error) => {
        if (error && !res.headersSent) res.sendStatus(404);
      },
    );
  });
  app.use('/api', bookingRouter(bookingRepository, config, payments));
  app.use(
    publicRouter(
      catalog,
      paymentPages(bookingRepository, config, payments, catalog),
      contactRouter(config, notificationService),
    ),
  );
  app.use((_req, res) =>
    res.status(404).render('pages/message', {
      title: 'Page not found',
      heading: 'A little off the part.',
      message: 'We could not find that page. Find your way back to the styles.',
      backUrl: '/styles',
      backLabel: 'Explore styles',
    }),
  );
  app.use((err, req, res, _next) => {
    if (err === invalidCsrfTokenError)
      return res.status(403).json({ error: 'Invalid CSRF token' });
    req.log.error({ err }, 'Request failed');
    if (req.path.startsWith('/api/'))
      return res.status(503).json({
        error: 'SERVICE_UNAVAILABLE',
        message:
          'Booking is temporarily unavailable. Please try again shortly.',
      });
    res
      .status(503)
      .send(
        'The studio website is temporarily unavailable. Please try again shortly.',
      );
  });
  return app;
}
export default createApp;
