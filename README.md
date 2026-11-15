# Mado African Braidz

Milestones 1–2: Express 4, Nunjucks SSR, Tailwind CSS v4, CSP-compatible Alpine.js, MySQL through Drizzle, and the database-backed public salon website. The app runs at **http://localhost:4780**; `/health` reports process health without querying MySQL.

## Requirements and Windows setup

Use Node.js 20 LTS, npm, Git, and MySQL 8 (or MariaDB 10.6+). In PowerShell:

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env` with a random SESSION_SECRET of at least 32 characters, your MySQL DATABASE_URL, and ADMIN_EMAIL / ADMIN_PASSWORD (12+ characters). URL-encode special characters in database credentials. Create the `mado` database using utf8mb4 first; migrations do not create databases. Keep MySQL configured for UTC. Never commit `.env`.

```powershell
npm run db:migrate
npm run db:seed
npm run build
npm run dev
```

Visit http://localhost:4780 and http://localhost:4780/health. `npm start` runs without file watching. PORT is read from the environment and defaults to 4780. This repository also installs a development-only Node 20 runtime; npm scripts use it when the global Node installation differs. Use a system Node 20 installation for production.

## Environment

`.env.example` lists every Section 12 variable plus owner seed credentials and LOG_DIR:

| Variables                                                        | Purpose                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| NODE_ENV, APP_URL, PORT                                          | Environment, canonical URL, listening port (4780 locally)                                      |
| SESSION_SECRET                                                   | Random secret, at least 32 characters                                                          |
| DATABASE_URL                                                     | MySQL connection URL for `mado`                                                                |
| ADMIN_EMAIL, ADMIN_PASSWORD                                      | Owner seed account; Argon2id hash stored, existing passwords preserved                         |
| STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET | Payment integration credentials for Milestone 4                                                |
| EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM, ADMIN_ALERT_EMAILS   | Email configuration for Milestone 7; use `log` locally                                         |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY                              | Future Web Push credentials                                                                    |
| TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY                         | Future booking/contact protection                                                              |
| UPLOAD_DIR                                                       | Absolute upload directory outside the deploy folder/webroot                                    |
| CRON_SECRET                                                      | Future cron authentication secret                                                              |
| LOG_DIR                                                          | Pino rotating log directory, defaults to `logs`; use an absolute persistent path in production |

Production validates HTTPS and payment/Turnstile/cron secrets. Future provider integrations remain outside this milestone; Postmark delivery configuration must be added with its implementation. Local unused provider keys can remain empty. Windows UPLOAD_DIR example is `C:/mado-uploads`; use `/home/<user>/mado-uploads` on cPanel. Logs rotate daily and retain 14 files. Session cookies are httpOnly/SameSite=Lax and secure in production; proxy trust is one hop.

## Database and seed

```powershell
npm run db:generate  # after editing src/db/schema.js; review generated SQL
npm run db:migrate
npm run db:seed
```

All 21 Section 9 tables are included. DATETIME(3) values use UTC, money uses integer cents. Sessions use the express-mysql-session schema with automatic table creation disabled. Section 10 seeds 13 styles, 30 price variants, six categories, Head wash, business/booking settings, and one owner. Seed runs in a transaction and preserves existing prices/settings/passwords on reruns, including nullable-length variants. Stop the app before running migrations. To change the existing owner email or password, edit ADMIN_EMAIL / ADMIN_PASSWORD in `.env` and run `npm run db:seed -- --update-owner`. This explicitly rotates the single owner account; ordinary seed reruns preserve its password.

## Checks

```powershell
npm run build
npm run lint
npm test
```

Tests use Supertest with the exported app factory and ephemeral ports, never a fixed application port. No database or Stripe account is needed for foundation unit tests. Live migrate/seed verification requires your local MySQL server and credentials. Foundation tests cover health, SSR, CSRF rejection, env validation, and flyer pricing. Booking/locking/webhook tests belong to their later milestones.

## cPanel deployment

Build locally with `npm ci` and `npm run build`; commit or upload `public/build`. Configure Passenger with Node 20, app root pointing at this repo, startup file `src/server.js`. Set environment variables in cPanel (NODE_ENV=production, HTTPS APP_URL, database credentials, persistent LOG_DIR and UPLOAD_DIR, all required secrets). Install runtime dependencies with `npm ci --omit=dev`, migrate, seed, and restart Passenger. Set PORT as provided by Passenger; the local fallback remains 4780. Enable SSL and daily database backups. Do not deploy node_modules from Windows. Cron jobs, Stripe webhook handling, emails, and admin login are future milestones and are not operational yet.

## Follow-ups

Provide real salon photography, an owner portrait, genuine reviews and owner approval of the biography and draft policies. The supplied logo artwork is preserved in a small WebP web copy; a clean vector remains a launch follow-up. Booking, payments, admin actions, and cron processing remain assigned to subsequent milestones.

Dependency overrides keep the session store on patched mysql2 and Drizzle tooling on patched esbuild. `npm audit` reports zero vulnerabilities after installation.

Local verification used XAMPP MariaDB 10.4.32 on port 3306 with database `mado`. Migrations, seed reruns, all stored flyer prices, and owner password verification passed. This XAMPP version is older than the specified MariaDB 10.6+ minimum; use MySQL 8 or supported MariaDB for deployment and repeat database verification there. Argon2 is pinned to the 0.41 release line for Windows Node 20 compatibility.

## Milestone 2: public pages and design library

After pulling these changes, run `npm install`, `npm run db:seed`, and `npm run build`, then `npm run dev`. Keep the existing `.env`; do not overwrite your credentials. Visit **http://localhost:4780**.

Public routes: `/`, `/styles` (server-rendered category filters), `/styles/:slug`, `/prices`, `/gallery`, `/about`, `/contact`, `/policies`, `/privacy`, `/terms`, and eight `/areas/:town` page shells. The booking routes provide honest call-to-book holding pages; no availability, holds, payments, or private booking details are implemented in this milestone. The contact form is a disabled preview and does not save or send messages. POST attempts return 503 after CSRF validation.

The catalog, prices, business information, booking defaults and public copy come from MySQL. New seed defaults live in `src/db/public-defaults.js`: `hours`, `policy`, and `seo.pages` (hero, about and FAQs). Reruns insert missing settings without overwriting owner edits. These values can be updated in the database now; the editor is Milestone 6. Both native MySQL JSON and XAMPP MariaDB JSON strings are handled. Style descriptions support sanitized Markdown, never raw scripts.

`/admin/design` is owner-only through a temporary browser HTTP Basic challenge using the **seeded database owner** email and password. Use the credentials from `.env`; after changing them, run `npm run db:seed -- --update-owner`. HTTPS is required in production and attempts are rate limited. This guard protects only the design preview; it does not implement the Milestone 5 admin login, staff permissions or dashboard. Preview controls never create bookings. Keep `ADMIN_PASSWORD` private.

Fonts are self-hosted Latin WOFF2 files copied at build time from Fontsource (licenses in `public/fonts`). The original supplied logo is preserved in `public/img/logo.png`; the layout uses the optimized `public/img/logo.webp` copy prepared from the same artwork. Include `public/fonts` and `public/img` in deployment alongside `public/build`. Public JS is a small same-origin module; native navigation, category filters, price anchors and FAQ disclosures work without JavaScript. Maps make no Google requests until clicked. There are no new environment variables.

For real photographs, public media records must have descriptive alt text and a root-relative `/img/...` path. For this milestone, put approved images under `public/img`; upload handling and private inspiration media come in Milestone 6. Associate `kind=style` records with a style, and use `kind=gallery` for gallery entries. The landing page, About page and gallery use frames and short clips from the owner-supplied studio videos. Styles without a verified style photo use type-led listings; a generic studio frame on a style detail is labelled as a look at the craft, not represented as that specific style. No stock images, invented client work or invented reviews are displayed.

Browser checks require local Chrome and the app/MySQL running:

```powershell
npm run test:browser
```

This checks 390px and 1440px layouts, WCAG rules, keyboard navigation, category filters, map consent, and owner design controls. It writes local screenshots and results under ignored `tmp/qa`. It uses the seeded owner credentials from `.env`. Unit/Supertest checks (`npm test`) use isolated catalog fixtures and need no running MySQL or fixed port.

Lighthouse mobile audits can be run using a current standalone Lighthouse CLI against `http://localhost:4780` and `/styles/knotless-braids`. Lighthouse 13 requires Node 22+ for its audit runner; the app and browser tests run on Node 20. The audit tool is kept separate from the app's dependencies. Repeat audits when images, footage or integrations change.

## Studio video and public redesign

The landing page now has a dark video-led hero, an editorial style list, a simplified price preview and real studio film sections. About and Gallery use the same supplied footage. Video playback controls work by mouse or keyboard. The hero may play silently when visible; reduced-motion and data-saver users get a still poster until they choose Play. Other clips load only on demand. Films pause offscreen and in background tabs, and an explicit pause is preserved. Without JavaScript, posters and direct MP4 links remain available.

Web assets are committed under `public/media` and served from `/media` with same-origin CSP and byte-range support. Include **public/media** when deploying alongside public/build, public/fonts and public/img. Ordinary `npm run build` does not require the original videos or FFmpeg.

To regenerate the web clips locally, place `video1.mp4`, `video2.mp4`, and `video3.mp4` in `docs/design/videos`, then run:

```powershell
npm run media:prepare
npm run build
npm run test:video
```

`media:prepare` uses development-only FFmpeg to crop/trim silent H.264 MP4s and extract WebP posters. The original approximately 56 MB of footage stays local and ignored by Git; the three prepared clips total approximately 3.6 MB, and their three posters approximately 90 KB. No runtime video processing or external video service is needed on cPanel. Do not run the media command against the production app.

Home copy defaults are updated for the redesign. The renderer upgrades the original “Braids done slowly,” scaffold headline while preserving a custom owner-written home heading. New databases get the revised copy from the seed. Business facts and catalog prices still come from MySQL.

Redesign validation: 63 unit/Supertest tests, the 25-case desktop/mobile accessibility check, and the video behavior checks pass. Mobile Lighthouse: Home 99 Performance / 100 Accessibility / 100 Best Practices / 100 SEO; Knotless Braids 99 / 100 / 100 / 100. Current compressed CSS is approximately 9.3 KB gzip and public JS 1.5 KB gzip. `scripts/prepare-logo.js` regenerates the approximately 12 KB WebP logo and is also run by `media:prepare`; the original artwork remains available.
