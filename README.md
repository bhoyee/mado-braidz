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

All 21 Section 9 tables are included. DATETIME(3) values use UTC, money uses integer cents. Sessions use the express-mysql-session schema with automatic table creation disabled. Section 10 seeds 13 styles, 30 price variants, six categories, Head wash and the 100% human hair upgrade, business/booking settings, and one owner. Seed runs in a transaction and preserves existing prices/settings/passwords on reruns, including nullable-length variants. Stop the app before running migrations. To change the existing owner email or password, edit ADMIN_EMAIL / ADMIN_PASSWORD in `.env` and run `npm run db:seed -- --update-owner`. This explicitly rotates the single owner account; ordinary seed reruns preserve its password.

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

Open **http://localhost:4780** and use Ctrl+F5 to refresh an existing preview. The landing page uses a silent studio video hero, a six-style photographic lookbook and the owner-supplied studio story. The salon header keeps address, daily opening hours and phone visible. The owner explicitly requested a new font/design direction: **Manrope** is now the main typeface and **Cormorant Garamond** the editorial accent, replacing the original Section 4 pairing. Both are self-hosted WOFF2 fonts with licenses in `public/fonts`.

Public routes include `/`, `/styles` (server-rendered category filters), every `/styles/:slug`, `/our-work`, `/about`, `/contact`, policy/privacy/terms drafts and eight area page shells. Prices, durations, business details and public copy come from MySQL. `/book` is the four-step booking wizard; result/manage routes remain informational until payment integration. The disabled contact form never claims to send a message; POST attempts return 503 after CSRF validation. Availability and temporary holds are implemented in Milestone 3; online payments are Milestone 4.

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

The braid length guide shown on style pages ("See the length guide") is prepared from `docs/design/Braids-Length-Guide.png` into `public/img/guides` (AVIF + WebP at 600/1100 widths). The web files are committed; regenerate them with `npm run images:guides` if the source image changes.

### Studio films

Silent clips are cut from the supplied videos in `docs/design/videos` (`video1.mp4`–`video5.mp4`, kept local/ignored):

- `studio-knotless` — the home hero (video5). It starts on its own when visible, loops, and has no controls; it never loads for reduced-motion or data-saver visitors (they see the poster) and pauses offscreen or in a background tab.
- `studio-tour` and `at-the-chair` — the home studio section; they play only when the visitor presses play.
- `transformation`, `braid-detail` and `studio-space` — used on Our Work / About or kept for later.

Media URLs carry a version stamp (`/media/<name>.mp4?v=…`, from the file's modified time), so a regenerated clip is never hidden by a browser's cached copy. Without JavaScript, posters and direct MP4 links remain available. Google Maps also loads only after a click.

Prepared files are committed under `public/media`. To regenerate them locally:

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

Milestone 2 validation: 66 unit/Supertest tests passed; build/lint and browser/video checks pass; npm audit reports zero vulnerabilities. Run current standalone Lighthouse against Home and a style detail when media or layout changes. Its audit runner may require a newer Node version; the app remains Node 20.

Final salon-header/video-hero Lighthouse mobile scores: **98/100/100/100** for Home and **99/100/100/100** for Knotless Braids. Scores apply to the current media and layout; repeat them after future changes.

### Salon header, opening hours and style pricing

The owner confirmed **Monday–Saturday, 6:00 AM–9:00 PM; Sunday, 10:00 AM–6:00 PM**, in `America/New_York`. These replace the earlier hours. The header shows the street/city, daily hours, and click-to-call phone on mobile and desktop. Larger salon branding and navigation include **Styles & Prices** and **Our Work**.

Prices are now part of each style. Open `/styles/knotless-braids`, choose Medium / Semi-medium / Small, then see that size's available length prices. The choice is a server-rendered GET URL such as `/styles/knotless-braids?size=small#lengths`, so it works without JavaScript and with back/refresh. Invalid sizes return 400. Only real catalog combinations are shown; no new prices or lengths were invented. Consultation styles keep their consultation path. Choosing a priced length leads to the existing informational booking page; availability/payment logic remains later work.

The old `/prices` URL redirects permanently to `/styles`, and `/gallery` redirects to `/our-work`. The dedicated price page is no longer in navigation. Three AI-labelled knotless size references help compare braid thickness; their optimized assets and metadata are included in the image manifest, with exact built-in generation prompts in `docs/KNOTLESS-SIZE-PROMPTS.json`.

For an existing local database, apply the latest owner-approved hours and About copy explicitly with:

```powershell
npm run db:seed
npm run content:sync
npm run build
```

`content:sync` applies the latest owner amendment: hours, shared booking capacity 3, 30-minute starts, included 50% human hair, the $40 100% human hair upgrade, About copy and the hair FAQ. It preserves other booking/policy values, unrelated copy and style prices. The upgrade is intentionally set to $40 and enabled. It is an explicit content update, not a startup hook; do not run it over later owner edits unless that overwrite is intended. New databases receive these defaults from the seed. No new environment variables are required.

## Hosting review deployment

Current hosting checks, the proposed review deployment and remaining access/configuration requirements are recorded in [docs/HOSTING-PREVIEW.md](docs/HOSTING-PREVIEW.md). The local hosting credentials are never part of the deployable release.

## Owner amendment: capacity and included hair

The salon can serve three clients concurrently, with starts every 30 minutes. Capacity must be checked over the entire appointment plus the existing 30-minute buffer, including staggered starts; counting only identical start times is insufficient. Times become unavailable when adding another appointment would exceed three at any point. Active holds count; expired holds do not. This is a shared salon capacity, without individual staff selection. Milestone 3 now enforces these availability and locking rules.

Hair with 50% human hair is included in the displayed style price. The optional 100% human hair upgrade adds 4000 cents ($40); Head wash remains 2500 cents ($25). No base style prices change. On an existing local database run `npm run db:seed` then `npm run content:sync`, and restart the app to load the new settings. No new environment variables or schema migrations are needed.

## Milestone 3: availability and temporary holds

Starts are every **30 minutes**, as explicitly confirmed by the owner. Up to three appointments may overlap, counting each full service duration and its 30-minute buffer. Hours are Mon–Sat 6am–9pm and Sun 10am–6pm Eastern. The default four-hour service therefore has its last start at 4:30pm Mon–Sat and 1:30pm Sunday, leaving room for the buffer. Notice remains 24 hours and the advance window 60 days; all are database settings.

Run `npm run content:sync` once to apply the corrected interval to an existing local database, then `npm run build` and `npm run dev`. Visit **http://localhost:4780/book**. No new application environment variables or database migrations were needed. Existing owner passwords and style prices remain unchanged.

The wizard accepts style/size/length, eligible extras, date/time, contact details, optional notes, an optional private inspiration image, required policy acceptance, and optional unticked marketing consent. URL and browser session storage retain choices; contact details stay out of the URL. The summary is calculated on the server, sticky beside the form on desktop and expandable at the bottom on mobile. Consultation styles offer deposit only and keep their final price unknown. The $40 human hair upgrade and $25 head wash are optional; base hair is already included.

Availability is exposed through `GET /api/availability?styleVariantId=&addonIds=&month=`. addonIds is a comma-separated list of IDs; styleId can identify consultation styles. `GET /api/availability/day` accepts the same selection plus `date=YYYY-MM-DD`. `GET /api/bookings/quote` returns authoritative prices. All selection endpoints reject unknown price fields. `POST /api/bookings/hold` requires the CSRF header and accepts JSON or multipart with one JSON `payload` field and optional `inspiration` image. Uploads are limited to 8 MB JPEG/PNG/WebP, checked by bytes, re-encoded and stored under UPLOAD_DIR outside the webroot. Files from failed holds are removed.

Holds are created only through bookingService inside a REPEATABLE READ transaction using calendar_locks and current locking reads. Concurrent duplicate-key lock deadlocks retry the entire rolled-back transaction. Capacity uses peak overlap, including staggered starts and live holds; expired holds free capacity immediately without a worker. Admin time blocks close the entire salon for their interval. Future admin changes must follow the same date-lock protocol. The current public opening model does not permit overnight appointments.

A successful hold is **pending_payment**, unpaid and expires after 30 minutes. It is not a confirmed appointment and does not send email or create a Stripe session. The UI explains this. When configured, the existing TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY enable the widget and server verification; local development with empty keys uses CSRF, honeypot, validation and rate limits. Production configuration already requires Turnstile secrets. Keep UPLOAD_DIR private and included in backups.

Checks:

```powershell
npm run build
npm run lint
npm test
npm run test:db
npm run test:booking:browser
```

`npm test` runs unit/Supertest tests without a database; the database integration file is intentionally skipped in this command. `npm run test:db` explicitly enables that suite and creates a random `mado_booking_test_*` database, migrates it, exercises 20 simultaneous holds, and removes only that disposable database afterward. It uses DATABASE_URL from ignored .env, or optional TEST_DATABASE_URL if provided. That database user needs CREATE/DROP DATABASE privileges for testing only; do not grant those privileges to the deployed application user. `test:booking:browser` uses local Chrome and an isolated app on an ephemeral test port with synthetic data, so it does not occupy port 4780 or write real appointments.

Follow-ups: Stripe checkout, webhook confirmation, late-payment conflict handling, expiry state cleanup, email delivery, full admin workflows and production deployment remain in later milestones or the separate hosting task. No confirmed booking can be created through the current public flow.

Milestone 3 validation: **83 unit/Supertest tests**, **4 real database integration tests**, and **9 mobile/desktop accessibility cases** pass. Details: [docs/MILESTONE-3.md](docs/MILESTONE-3.md).
