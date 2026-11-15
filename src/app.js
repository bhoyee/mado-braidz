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
  logger = createLogger(config),
} = {}) {
  const app = express();
  app.set('trust proxy', 1);
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
  app.use('/contact', limits.contact);
  app.use('/api/availability', limits.availability);
  app.use(csrfSynchronisedProtection);
  nunjucks.configure(fileURLToPath(new URL('./views', import.meta.url)), {
    autoescape: true,
    express: app,
    noCache: config.NODE_ENV !== 'production',
  });
  app.set('view engine', 'njk');
  app.get('/', (_req, res) =>
    res.render('pages/home', { title: 'Mado African Braidz' }),
  );
  app.use((_req, res) => res.status(404).send('Page not found'));
  app.use((err, req, res, _next) => {
    if (err === invalidCsrfTokenError)
      return res.status(403).json({ error: 'Invalid CSRF token' });
    req.log.error({ err }, 'Request failed');
    res.status(500).send('Something went wrong');
  });
  return app;
}
export default createApp;
