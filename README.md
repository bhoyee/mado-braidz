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

Replace generated style references with verified service photos when available; provide an owner portrait, genuine reviews and owner approval of the biography and draft policies. The supplied logo artwork is preserved in a small WebP web copy; a clean vector remains a launch follow-up. Booking, payments, admin actions, and cron processing remain assigned to subsequent milestones.

Dependency overrides keep the session store on patched mysql2 and Drizzle tooling on patched esbuild. `npm audit` reports zero vulnerabilities after installation.

Local verification used XAMPP MariaDB 10.4.32 on port 3306 with database `mado`. Migrations, seed reruns, all stored flyer prices, and owner password verification passed. This XAMPP version is older than the specified MariaDB 10.6+ minimum; use MySQL 8 or supported MariaDB for deployment and repeat database verification there. Argon2 is pinned to the 0.41 release line for Windows Node 20 compatibility.

## Milestone 2: photo-led public site

After pulling updates, keep your existing `.env` and run:

```powershell
npm install
npm run db:seed
npm run build
npm run dev
```

Open **http://localhost:4780** and use Ctrl+F5 to refresh an existing preview. The landing page uses a supplied knotless-braid photograph, a six-style photographic lookbook, a studio film section and a printed price preview. The owner explicitly requested a new font/design direction: **Manrope** is now the main typeface and **Cormorant Garamond** the editorial accent, replacing the original Section 4 pairing. Both are self-hosted WOFF2 fonts with licenses in `public/fonts`.

Public routes include `/`, `/styles` (server-rendered category filters), every `/styles/:slug`, `/prices`, `/gallery`, `/about`, `/contact`, policy/privacy/terms drafts and eight area page shells. Prices, durations, business details and public copy come from MySQL. Booking/result/manage paths remain informational holding pages. The disabled contact form never claims to send a message; POST attempts return 503 after CSRF validation. Booking logic and payments are later milestones.

`/admin/design` uses a temporary browser Basic-auth challenge for the seeded owner account. Use the owner email/password from `.env`; after changing credentials, run `npm run db:seed -- --update-owner`. HTTPS is required in production. Failed credentials are limited; successful preview refreshes and empty browser challenges do not consume the failure quota. Full admin authentication remains Milestone 5.

### Style images and provenance

Every one of the 13 seeded styles has an image. Four use owner-supplied references (Knotless, Boho Knotless, Island Twist, Crochet); the remaining nine use built-in image generation and are visibly labelled **AI style reference** on cards and details. Generated pictures illustrate hairstyles; they are not client photographs or testimonials. The gallery includes three additional supplied photos without creating unconfirmed bookable services or prices.

The image manifests live in `src/db/style-image-manifest.json` and `src/db/gallery-image-manifest.json`. The seed inserts missing media associations and refreshes responsive metadata for these managed asset paths, while preserving other photos, captions, prices and settings. Owner-added style photos sorted ahead of the seeded references take priority. MariaDB JSON strings and native MySQL JSON are both supported.

Optimized files are committed in `public/img/styles` (AVIF + WebP at 480/960 widths) and `public/img/gallery` (WebP). Original supplied images stay in ignored `docs/design/imgs`; generated source PNGs stay in ignored `assets/style-references`. Final web assets are present in the checkout and ordinary builds do not require the source images or an image-generation API key. The exact built-in generation prompts are recorded in `docs/STYLE-IMAGE-PROMPTS.json`.

If all local sources are available, regenerate resized/encoded assets with:

```powershell
npm run images:prepare
npm run db:seed
npm run build
```

`images:prepare` uses Sharp for deterministic resizing/encoding. It does not call image generation. Style-source mappings are in `src/db/style-image-sources.json`; gallery mappings are in `src/db/gallery-image-sources.json`. Do not relabel an AI reference as a real client photograph.

### Studio films

The three supplied videos remain available as silent 10–12 second clips. All current public films are **play on request**. They pause offscreen/background and preserve a manual pause. Reduced-motion and data-saver browsing never triggers an automatic download. Without JavaScript, posters and direct MP4 links remain available. Google Maps also loads only after a click.

Prepared files are committed under `public/media`. To regenerate them locally from `docs/design/videos/video1.mp4`, `video2.mp4`, and `video3.mp4`:

```powershell
npm run media:prepare
npm run build
```

The media command uses development-only FFmpeg, removes audio, trims/crops the clips and extracts posters. It also regenerates the optimized logo from `docs/design/logo.png`. Original video masters stay local/ignored. There is no runtime media processing on cPanel.

### Deployment and checks

Deploy `public/build`, **public/fonts**, **public/img** and **public/media**, install runtime dependencies, run migrate/seed and restart Passenger. No new environment variables were added. Existing normal build/test commands remain unchanged.

```powershell
npm run build
npm run lint
npm test
npm run test:browser
npm run test:video
```

Browser checks require local Chrome, MySQL and the app running on port 4780. They verify 390px/1440px layouts, WCAG A/AA rules, image decoding, keyboard controls, filters, map consent and owner preview access. Video checks exercise all clips and request-only playback. Reports/screenshots go in ignored `tmp/qa`. Unit/Supertest tests use catalog fixtures and no fixed port or running database.

Current validation: 65 unit/Supertest tests pass; build/lint and browser/video checks pass; npm audit reports zero vulnerabilities. Run current standalone Lighthouse against Home and a style detail when media or layout changes. Its audit runner may require a newer Node version; the app remains Node 20.

Final photo-led design Lighthouse mobile scores: **100/100/100/100** for Home and Knotless Braids. Scores apply to the current media and layout; repeat them after future changes.
