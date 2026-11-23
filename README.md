# Mado African Braidz

Milestones 1–6: Express 4, Nunjucks SSR, Tailwind CSS v4, Alpine.js, MySQL through Drizzle, public pages, booking, Stripe/manual payments and the owner admin portal with catalog/settings management. The app runs at **http://localhost:4780**; `/health` reports process health without querying MySQL.

## Requirements and Windows setup

For the cPanel server setup, see [docs/DEPLOY.md](docs/DEPLOY.md). Local development remains on port **4780**.

The GitHub Actions workflow checks pushes to `main` and deploys production through cPanel HTTPS using the supplied hosting login, with a database backup, Drizzle migrations, an app restart and served-revision checks. A short server cron task processes each uploaded release; no permanent worker or API token is needed. Pull requests run checks without deploying. See [the CI/CD setup and recovery instructions](docs/DEPLOY.md#github-actions-production-deployment) for encrypted environment secrets, the deployment cron and rollback behavior. Production runtime credentials stay on the server; local `.env` is never deployed.

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

Visit http://localhost:4780 and http://localhost:4780/health. `npm run dev` keeps the local server running without automatic restarts, so sign-in and booking redirects are not interrupted by file-watcher restarts. Restart it after changing server code or `.env`. Developers can opt into automatic restarts with `npm run dev:watch`; use the normal `dev` command for browser testing. Both development commands process queued email jobs every minute. `npm start` runs the server without the development jobs timer. PORT is read from the environment and defaults to 4780. This repository also installs a development-only Node 20 runtime; npm scripts use it when the global Node installation differs. Use a system Node 20 installation for production.

## Environment

`.env.example` lists every Section 12 variable plus owner seed credentials and LOG_DIR:

| Variables                                                                    | Purpose                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| NODE_ENV, APP_URL, PORT                                                      | Environment, canonical URL, listening port (4780 locally)                                            |
| SESSION_SECRET                                                               | Random secret, at least 32 characters                                                                |
| DATABASE_URL                                                                 | MySQL connection URL for `mado`                                                                      |
| ADMIN_EMAIL, ADMIN_PASSWORD                                                  | Owner seed account; Argon2id hash stored, existing passwords preserved                               |
| STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, STRIPE_WEBHOOK_SECRET             | Payment integration credentials for Milestone 4                                                      |
| EMAIL_PROVIDER, BREVO_API_KEY, EMAIL_ENABLED, EMAIL_FROM, ADMIN_ALERT_EMAILS | Use `brevo` and `EMAIL_ENABLED=true` for real local email testing; `log` is an optional preview mode |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY                                          | Future Web Push credentials                                                                          |
| TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY                                     | Future booking/contact protection                                                                    |
| UPLOAD_DIR                                                                   | Absolute upload directory outside the deploy folder/webroot                                          |
| CRON_SECRET                                                                  | Future cron authentication secret                                                                    |
| LOG_DIR                                                                      | Pino rotating log directory, defaults to `logs`; use an absolute persistent path in production       |

Production validates HTTPS and payment/Turnstile/cron secrets. Milestone 7 adds Brevo delivery; see the notification activation guide below. Local unused provider keys can remain empty. Windows UPLOAD_DIR example is `C:/mado-uploads`; use `/home/<user>/mado-uploads` on cPanel. Logs rotate daily and retain 14 files. Session cookies are httpOnly/SameSite=Lax and secure in production; proxy trust is one hop.

## Database and seed

```powershell
npm run db:generate  # after editing src/db/schema.js; review generated SQL
npm run db:migrate
npm run db:seed
```

All 21 Section 9 foundation tables are included; Milestone 4 adds checkout_attempts (22 total). DATETIME(3) values use UTC, money uses integer cents. Sessions use the express-mysql-session schema with automatic table creation disabled. Section 10 seeds 13 styles, 30 price variants, six categories, Head wash and the 100% human hair upgrade, business/booking settings, and one owner. Seed runs in a transaction and preserves existing prices/settings/passwords on reruns, including nullable-length variants. Stop the app before running migrations. To change the existing owner email or password, edit ADMIN_EMAIL / ADMIN_PASSWORD in `.env` and run `npm run db:seed -- --update-owner`. This explicitly rotates the single owner account; ordinary seed reruns preserve its password. With more than one owner, `--update-owner` stops without changing anything; use the admin portal or "Forgot password" instead.

### Search and social sharing

`src/services/pageSeo.js` supplies descriptions, canonical URLs and sharing tags for public pages, using `APP_URL` as the site address. Private and unknown pages are `noindex`. After a logo or wording change, run `npm run images:share` (local Playwright only) and commit `public/img/share-card.jpg`.

### Add another owner

`ADMIN_EMAIL` holds one address and is not a login list. To give another person full owner access, run this in the app root of the environment whose `.env` points to the right database:

```bash
npm run admin:add -- --email=person@example.com --name="Person Name"
```

No restart is needed. Existing accounts are untouched and rerunning is safe. The new owner opens `/admin/forgot`, sets a password from the emailed link (email must be configured and `run-jobs.js` running), and can then enable their own two-factor. Alert emails are separate: use Settings or `ADMIN_ALERT_EMAILS`.

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

The current deployment and verification record is [docs/DEPLOY.md](docs/DEPLOY.md). Earlier access troubleshooting is retained in [docs/HOSTING-PREVIEW.md](docs/HOSTING-PREVIEW.md) as historical context. The local hosting credentials are never part of the deployable release.

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

Follow-ups: Stripe checkout, webhook confirmation, late-payment conflict handling, expiry state cleanup, email delivery, full admin workflows and production deployment remain in later milestones or the separate hosting task. Milestone 3 only creates unpaid holds; Milestone 4 below adds Stripe confirmation.

Milestone 3 validation: **91 unit/Supertest tests**, **4 real database integration tests**, and **17 mobile/desktop accessibility cases** pass. Details: [docs/MILESTONE-3.md](docs/MILESTONE-3.md).

Booking page controls use scrollable, touch-friendly menus for style, braid size and length, with keyboard/typeahead support and purple hover/selection feedback. The compact intro highlights included hair in yellow and displays the non-refundable deposit policy.

Booking contact numbers are restricted to valid US numbers on the server. Form errors use red inline messages and borders with short labels such as “Required field”, “Invalid email” and “Invalid phone number”. The policy is a full-width bold banner; it stays on one line on wide screens and wraps on mobile.

## Milestone 4: Stripe Checkout and webhooks

Install dependencies, apply migration `0002_amazing_ezekiel_stane.sql`, and rebuild:

```powershell
npm install
npm run db:migrate
npm run build
npm run dev
```

The local application remains **http://localhost:4780**. Set STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY in ignored `.env` using matching **test** keys. Local/test environments reject live keys. Use production mode and matching live credentials only during the later launch process. The public form enables secure Stripe checkout when a secret key is configured; without keys, the existing unpaid-hold preview remains available. No card details touch this application.

For manual local webhook testing, run Stripe CLI in another terminal:

```powershell
stripe login
stripe listen --forward-to http://localhost:4780/webhooks/stripe --events checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,refund.updated,refund.failed
```

Copy the listener's signing secret into STRIPE_WEBHOOK_SECRET in ignored `.env`, then restart the app. The listener secret differs from a Dashboard endpoint's secret. Do not commit or paste keys into logs. Hosted Checkout uses the payment methods enabled in the Stripe Dashboard, USD prices and no automatic tax/adaptive conversion. No Stripe.js card form is embedded.

Checkout attempts persist the server snapshot amount, expiry, type and session ID. Initial checkout uses `hold-<bookingId>` as its Stripe idempotency key; balance attempts have separate keys. Retrying a failed redirect reuses the same hold/session; a session-bound request key prevents duplicate hold creation on replay. Checkout reserves about 30 minutes with a **10-second network allowance**, and the local hold matches Stripe's expiry. Returning through `/book?resume=<ref>` expires the unpaid Stripe session and releases the hold before restoring details. If payment completed during cancellation, the client goes to the confirmation check instead.

Only verified raw-body webhooks confirm appointments. Event IDs, payment-intent checks and date locks make duplicate deliveries safe. Late payment rechecks full-interval capacity three and time blocks; if the slot is full, a durable idempotent refund task is created and attempted immediately. Failed or pending refunds are retried by cron. Partial/full `charge.refunded` events reconcile cumulative refunds without subtracting twice. A private `/booking/:token` page shows the saved appointment and offers an exact balance checkout for eligible deposit-paid bookings. Consultation bookings need a final quote before balance checkout.

`/book/success` polls stored payment status every two seconds for up to one minute. It never confirms from the redirect URL alone. Confirmation includes the paid amount, balance, directions, a calendar download and a private manage link. Status requires the original session or private booking link. Session IDs and private manage tokens are masked in application request logs.

On cPanel, schedule this command every five minutes using the host's Node 20 executable:

```text
*/5 * * * * cd /home/<user>/mado-app && /path/to/node scripts/run-jobs.js >> /home/<user>/logs/mado-jobs.log 2>&1
```

The runner holds MySQL `GET_LOCK('jobs', 0)` so two cron runs do not overlap. It expires unpaid holds and retries durable Stripe refunds. Email jobs and admin notifications are queued, but email delivery and the full admin interface remain later milestones. Existing holds stop blocking as soon as they expire even before cron updates their status.

Checks:

```powershell
npm run build
npm run lint
npm test
npm run test:db
npm run test:booking:browser
npm run test:payments:browser
npm run test:stripe:e2e
```

The last command is a **real sandbox-only** hosted-card test using Stripe CLI and local Chrome. It refuses live keys, creates a disposable local database, opens the hosted test checkout, uses the published Stripe test card, waits for the actual forwarded webhook, then removes only its own temporary database and closes its browser/listener. Keys are passed through environment variables, not command arguments. It does not change the development database or occupy port 4780. Browser verification challenges may require a manual sandbox checkout. Run this only after adding valid test keys. It creates test-mode Stripe records; no real money is processed.

On 17 November 2026, the hosted main-domain app completed a real Stripe sandbox-card checkout and confirmed through Stripe's actual webhook. The test payment was refunded and the test appointment cancelled. The separate local CLI harness is not recorded as passing. Full details are in [docs/DEPLOY.md](docs/DEPLOY.md) and [docs/MILESTONE-4.md](docs/MILESTONE-4.md). Real-money activation still requires the owner's launch checks.

## Pay page and manual transfer review

`/pay` is linked from the footer. One search field accepts an exact phone number, email address or booking confirmation code. Phone/email lookups can return multiple pending payments without an additional code. Results grant payment-only access tied to the current browser session for one hour, without exposing private management tokens, client contact details, notes or proofs. This does not authorize cancellation. The original private visit link remains available. Cancelled/expired bookings and known-price bookings without an eligible balance do not offer payment.

Set `MANUAL_PAYMENT_NAME` (default Magdaline Arrey), `ZELLE_RECIPIENT` (the verified Zelle email/phone), and `CASHAPP_CASHTAG` (the verified $cashtag) in ignored `.env` locally and cPanel environment settings on the server. A transfer method is displayed only when its destination is configured. Do not invent transfer destinations. Restart the app after changing config. `MANUAL_REVIEW_HOURS` defaults to 24 (1–48); initial proof submission extends the existing capacity hold up to this limit, never beyond the appointment start. Unreviewed holds then expire normally. Balance submissions do not change an already confirmed appointment.

Run `npm run db:migrate` before starting the updated app; the additive `payment_proofs` migration stores private, re-encoded image references and review metadata. Proofs accept JPEG/PNG/WebP, up to 8 MB, stored under ignored/outside-webroot `UPLOAD_DIR`. Do not put receipts in public media. Submitting a proof does not record money or confirm a visit. Card Checkout is blocked while proof review is pending to prevent duplicate payment.

The owner signs in at `/admin/login`, then opens `/admin/payment-reviews` (HTTPS required in production). Verify the transfer in the actual Zelle/Cash App account, inspect the private screenshot, then approve or reject. Owner decisions are CSRF protected, date locked, audited and idempotent. Approval records the expected server-calculated amount, reconciles the balance and confirms only if capacity is still available. If the appointment is no longer available or money differs, arrange a manual refund/reconciliation with the client; do not approve the proof. Rejection of an initial proof releases the chair. Staff cannot review proofs. Confirmation email jobs are queued; actual email delivery remains Milestone 7.

Manual-payment browser verification: `npm run test:manual:browser` uses generated test images, fake Stripe and an isolated in-memory repository. It does not send transfers or modify the development database. Run `npm run test:db` for real disposable-database row locking and concurrent approval verification.

## Multiple appointments and Pay all

A phone/email search lists **every eligible linked booking**, with an individual Pay now action and the total due now. A booking reference lists only that booking. Results have no fixed booking-count cutoff. Payments already awaiting manual review stay visible but are excluded from card checkout to prevent paying twice.

When at least two payments are ready, **Pay all** opens one Stripe Checkout for the server-computed sum. `payment_batches` stores immutable per-booking allocations; its attempts prevent a simultaneous individual or manual payment for those same bookings. Reservation and webhook allocation take all affected calendar-day locks in sorted order. Only a verified paid webhook credits the entries. Group cancellation/expiry releases unpaid initial holds while preserving appointments that were already confirmed. Conflict refunds apply only to the affected allocation; other appointments remain paid.

Run `npm run db:migrate` for `0004_misty_ozymandias.sql` before starting/deploying this version (24 tables). Cron also expires combined checkouts. No new environment variables are required. In Stripe webhooks, retain the existing events and add `refund.updated` and `refund.failed` for asynchronous combined-refund reconciliation. Do not issue allocation-specific refunds using the old single-booking refund code: shared PaymentIntents must use the combined-refund path. Untagged refunds issued directly in Stripe Dashboard are allocated in booking order and create an owner reconciliation notification; verify these against the intended bookings.

Validation commands: `npm run test:batch:browser` checks phone/email versus reference lookup, individual/combined controls, deposits, balances, cancellation and accessibility in mobile/desktop Chrome using fake Stripe. `npm run test:stripe:batch` uses real **test-only** Stripe keys, creates a disposable local database, verifies a combined Checkout total, expires only its own unpaid session, and drops only its own database. It never submits a card or takes payment. Real hosted-card confirmation remains the separate `npm run test:stripe:e2e` acceptance check.

## Owner portal (Milestone 5)

For catalog and settings management, see [Milestone 6](docs/MILESTONE-6.md). The owner navigation now includes Styles & prices, Extras, Availability, Photos & Our Work, Clients, Settings and Page redirects. Apply `0006_icy_magneto.sql` with `npm run db:migrate`. New styles start as drafts; add prices or select consultation pricing, then publish. Public catalog changes appear immediately while existing booking prices stay unchanged.

To change an image, use **New photo → Replace photo** on its photo card or style page. The existing caption, style link and order are kept. Styles without photos stay listed with an **Add photo** upload, so a removed photo never means recreating the style. Photo removal uses a styled Cancel/Remove confirmation.

No new env variables are needed. Photos use the existing persistent `UPLOAD_DIR/catalog` directory and survive releases. The image route exposes only generated catalog WebP/AVIF files; proofs and inspiration images stay private. Balance-method settings affect remaining balances and do not disable initial deposit methods. Email settings save preferences for Milestone 7; they do not enable email delivery yet.

`npm run test:db` includes booking and owner-catalog integration tests against disposable databases. `npm run test:management:browser` verifies real owner forms, image upload/order, public updates and accessibility at 390/1440 px in Chrome, using a separate disposable database and fake Stripe. It requires local MySQL credentials with permission to create/drop those test databases; it never edits the real salon catalog.

Photos & Our Work uses a searchable photo grid with placement and style filters. **Add photo** opens an upload dialog with an image preview; **Manage photo** edits descriptions/placement, replaces only the image, or removes a photo after confirmation. Missing style photos are grouped above the library. Use **Reorder photos** to show movement controls, then save or cancel the new order; no display-order numbers are needed. `npm run test:gallery:browser` checks these flows and accessibility at 390/1440 px using a disposable database and temporary uploads, without changing salon photos.

The **Videos** tab includes all five existing studio clips and shows where they appear. **Hide video** takes a clip off its public pages; **Publish video** restores it. Hiding a built-in home/about clip shows the salon entrance image in its place. **Manage video** edits its title, description and Our Work placement. **Add video** accepts MP4/H.264 clips up to 60 seconds, 30 MB and 1920 pixels on the longest side; MOV/HEVC needs exporting as a compatible MP4 first. The browser picks a JPEG cover automatically, or the owner can choose a cover image (maximum 8 MB). New uploads appear on Our Work when published. Videos are validated on the server and descriptive/location metadata boxes are cleared; no FFmpeg or production conversion worker is required. Video files persist in `UPLOAD_DIR/videos`, covers in `UPLOAD_DIR/catalog`, and settings in the existing database `settings` table. Include the entire upload directory and database in backups. Saved/hidden video files and cover variants are protected from orphan cleanup. No migration or new env variables are required. `npm run test:videos:browser` exercises real upload, automatic cover generation, playback, byte ranges and publish/hide in a disposable database at mobile/desktop widths.

Run `npm run db:migrate` for additive migration `0005_broken_mandroid.sql`, then `npm run build` and `npm run dev`. Open **http://localhost:4780/admin**. Use the existing seeded `ADMIN_EMAIL` and `ADMIN_PASSWORD` from the ignored local `.env`; changing `.env` alone does not change an already-seeded password. There is one owner and no staff-management UI. Non-owner accounts are denied access.

The owner can view dashboard totals and a day/week/month calendar, search/export bookings, create appointments, edit client details/style/extras, move dates and times, add private notes, confirm/cancel/complete/no-show, record received payments, review transfers and issue allocation-specific refunds. Date-only edits preserve agreed prices. Moves enforce hours, 30-minute start intervals, duration, buffer and three-client capacity. Owner-created appointments may be short-notice, but cannot bypass hours or capacity. Open card checkout, pending transfer review and outstanding refund requests block conflicting changes. Unpaid owner overrides are labelled and retain a payable balance through their private visit link.

The owner menu groups **Styles & prices → Styles / Extras**, **Appointments → All appointments / Payment reviews**, and **Settings → Studio details / Opening hours / Sign-in & security**. Existing page URLs and form actions continue to work. Settings has these three tabs. Password changes live at `/admin/settings?tab=security`; the old `/admin/security` address redirects there. There is no separate security menu item or two-factor setup panel. Password changes still require the current password and revoke existing sessions; any previously enabled authenticator protection remains enforced.

The live search beside the notification bell is available throughout the owner portal. It searches appointments (including booking codes and formatted phones), clients, styles, extras, photo/video descriptions and current portal pages. Type at least two characters; grouped results link directly to the matching record or section. Arrow keys browse results, Enter opens one, and Escape closes the list. Empty matches show “No results found”. The owner-only `/admin/api/search` endpoint validates and rate-limits requests, returns at most 20 results, sends `Cache-Control: no-store`, and keeps search text out of request logs. Private inspiration uploads and hidden maintenance menus are excluded. No schema or environment changes are needed. Run `npm run test:search:browser` for focused mobile/desktop interaction, accessibility, race and literal-text safety checks.

Login has persistent lockout after five failures for 15 minutes, optional authenticator two-factor and session revocation after security changes. Keep `SESSION_SECRET` stable: it protects sessions, private links and encrypted TOTP secrets. For production password-reset email, use existing `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and verified `EMAIL_FROM`. With local log email mode, the private reset URL is written to ignored `tmp/admin/password-reset.txt`; there is no production file fallback. Reset URLs expire after 30 minutes, are single-use and do not disable two-factor. No new env variables are required.

Client emails requested from owner actions are queued for Milestone 7. Until delivery is enabled, copy the private visit/payment link from the booking details. Stripe refunds are durable jobs retried by the existing cron command; manual refunds only record money the owner has already returned herself. Settings, catalog CRUD and time-block editing remain Milestone 6.

Verify with `npm run lint`, `npm test`, `npm run test:db` and `npm run test:admin:browser`. The owner browser test uses fake Stripe, in-memory data and an ephemeral port; MySQL integration tests use a disposable database. See [docs/MILESTONE-5.md](docs/MILESTONE-5.md) for the full scope and owner setup notes.

`TURNSTILE_ENABLED` defaults to `true`. After the initial deferred setup, the owner supplied genuine keys and enabled it on the server. Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`, keep the flag true and restart Passenger after key changes. Tokens are verified server-side against the configured `APP_URL` hostname and the expected form action; missing, invalid, expired/replayed or wrongly scoped tokens are rejected. Cloudflare outages fail closed. Booking uses action `booking`; the contact preview uses `contact`. Contact delivery remains disabled until email setup, as the owner requested—no contact messages are stored or sent. Both forms retain CSRF, rate limits and honeypots. Add localhost to the widget's allowed hostnames if you want to use these domain keys during local development; do not use dummy keys on the server. The Passenger startup file is `app.cjs`, which loads the ES-module server; command-line development still uses `src/server.js`.

# Men’s services

Men’s Invisible Locs ($120) and Freestyle Stitch Cornrows ($80) reserve four hours each, use a single standard service option and the existing $30 deposit. Both appear on the home page, under the Men’s Braids & Locs category and in booking. The supplied hairstyle photos appear on the home page and style pages; replace them through the owner’s Photos & Our Work screen. Men’s prices appear in their dedicated home section rather than being repeated in the home price menu.

Fresh installs include these services in `npm run db:seed`. For an existing database, `npm run catalog:men` adds only missing men’s styles and their initial prices, and imports the supplied men’s photos once; it preserves existing services, owner edits and bookings. Production deployment runs this additive command after migrations. No new environment variables are needed.

# Notifications and emails (Milestone 7)

See [the notification setup and activation guide](docs/MILESTONE-7.md). Build compiles the branded MJML email layout. Run `npm run db:migrate` for the email delivery-key and suppression migrations. The existing five-minute jobs cron schedules and sends notifications; no separate worker is needed.

For real local email tests, set `EMAIL_PROVIDER=brevo`, `EMAIL_ENABLED=true`, and the verified `BREVO_API_KEY`, `EMAIL_FROM` and `EMAIL_REPLY_TO` in ignored `.env`. Set `NOTIFICATIONS_START_AT` to the UTC time you first enable delivery so historical test messages are not sent. Keep that value stable afterward. `npm run dev` starts **http://localhost:4780** and runs the existing jobs command at startup and every minute; it stops scheduling jobs when development exits. Emails can take up to a minute to leave the queue. Use `npm run jobs` to process them immediately. `npm start` does not schedule jobs; production retains its five-minute cron. Local payment links point to localhost and must be opened on this PC; email logo images use the public salon URL so they display in inboxes.

Owners can enable phone/tablet alerts in **Notifications**, then select **Send test alert** to check the current device. The test sends immediately to that owner's registered device; provider acceptance does not guarantee the phone displayed it. Check browser and operating-system permissions and Do Not Disturb if nothing appears. iPhone/iPad users must open the portal as a Home Screen web app on iOS/iPadOS 16.4 or later. Test alerts are limited to three per minute.

For the public WhatsApp chat button, set `WHATSAPP_NUMBER` in the private `.env` and restart. Owner-only booking/payment-review alerts can use `WHATSAPP_PROVIDER=callmebot`, `WHATSAPP_OWNER_NUMBER` and the activated number's `CALLMEBOT_API_KEY`. Alerts stay disabled until tested and activated. A Meta provider is also available. See [WhatsApp setup](docs/WHATSAPP.md) for activation, environment settings and changing the recipient.

New private environment variables: `BREVO_API_KEY`, `BREVO_WEBHOOK_SECRET`, `EMAIL_ENABLED` (default `false`), `EMAIL_REPLY_TO`, `NOTIFICATIONS_START_AT` (UTC activation time), and `VAPID_SUBJECT`. Existing `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, `EMAIL_FROM` and `ADMIN_ALERT_EMAILS` are used. Keep delivery disabled until the sending domain and owner inbox test are verified. Set the activation time before enabling delivery to avoid sending historical queued emails. Contact messages remain disabled until delivery is enabled.

Styles are listed newest first automatically in the owner portal and public catalog. Editing a style keeps its position. Display-order fields are omitted from style and price-option forms; price options retain their existing order, with new options added at the end.
