import { join } from 'node:path';
import { statSync } from 'node:fs';
import { createDatabase } from './db/index.js';
import { createCatalogService } from './services/catalogService.js';
import { publicRouter, money } from './routes/public/index.js';
import { designRouter } from './routes/admin/design.js';
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
  catalog,
  logger = createLogger(config),
} = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.set('env', config.NODE_ENV);
  let database;
  catalog ??= createCatalogService(
    (database = createDatabase(config.DATABASE_URL)).db,
  );
  app.locals.closeDatabase = () => database?.pool.end();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          frameSrc: ["'self'", 'https://maps.google.com'],
          fontSrc: ["'self'"],
          mediaSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.NODE_ENV === 'production' ? [] : null,
        },
      },
      hsts: config.NODE_ENV === 'production' ? undefined : false,
    }),
  );
  app.use(compression());
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
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
  // Mount the signed Stripe raw-body route here before JSON parsing in Milestone 4.
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
  app.use('/admin/login', limits.login);
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
  app.use('/admin', designRouter(catalog, limits.preview));
  app.use(publicRouter(catalog));
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
    res
      .status(503)
      .send(
        'The studio website is temporarily unavailable. Please try again shortly.',
      );
  });
  return app;
}
export default createApp;
