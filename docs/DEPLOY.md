# cPanel deployment

Main domain: **https://madoafricanbraidz.com**. Local development stays on **http://localhost:4780**. The hosted Node app also receives `PORT=4780`; Passenger routes the public HTTPS requests.

## Server layout

- App root: `/home/madoafri/mado-app`, outside the web root.
- Node: CloudLinux **20**, Passenger startup file **`app.cjs`**. The CommonJS bridge loads `src/server.js` as an ES module.
- Database: dedicated cPanel-prefixed `madoafri_mado`, with a separate application user restricted to that database. Never use local root credentials on the server.
- Uploads: `/home/madoafri/mado-uploads`.
- Logs: `/home/madoafri/logs/mado`.
- Deployment state/credentials: `/home/madoafri/mado-deploy`, private, outside `public_html`.
- Backups: `/home/madoafri/mado-backups`, private, outside `public_html`.

The old web root is archived before cutover. Keep the backup until the owner has verified the replacement. Never publish `.env`, receipts, database dumps or deployment credentials under `public_html`.

## Release process

1. Build and verify locally: `npm install`, `npm run build`, `npm run lint`, `npm test`, plus booking/database/browser checks appropriate to changes.
2. Commit the prepared `public/build` assets. Package the verified release with Git, excluding local secrets, uploads and Windows dependencies.
3. Upload/extract the release into the app root; preserve the private server `.env` and external uploads. Install Linux packages using the selected CloudLinux Node environment and `npm ci --omit=dev`. Do not build on this shared host.
4. Set server-specific production configuration in the app's private `.env` (or cPanel environment settings). Required settings include `NODE_ENV=production`, HTTPS `APP_URL`, `PORT=4780`, a stable random `SESSION_SECRET`, the server `DATABASE_URL`, Stripe keys and endpoint-specific webhook secret, `CRON_SECRET`, owner seed credentials, and the persistent absolute upload/log paths. Never upload the local `.env` containing cPanel/SSH credentials.
5. Run `npm run db:migrate`, then `npm run db:seed` in the app root. Seeding preserves existing prices, settings and passwords. Back up an existing database before migrations. Never use `--update-owner` during a routine deployment.
6. Register the Node app with CloudLinux on the main domain at `/`, production mode, Node 20, startup `app.cjs`. Restart it through cPanel or `cloudlinux-selector restart --json --interpreter nodejs --app-root mado-app`.
7. Add a five-minute cron entry using the selected Node executable, changing into the app root before `node scripts/run-jobs.js`. Preserve unrelated cron entries. The runner uses the existing MySQL lock and handles expired holds and refund retries.
8. Configure the Stripe **test-mode** webhook endpoint at `https://madoafricanbraidz.com/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `refund.updated`, `refund.failed`. Its `whsec_...` differs from the local Stripe CLI listener secret.
9. Check HTTPS home/styles/booking/pay, static images/fonts/video, `/health`, actual database access and owner login. Verify protected admin routes, secure cookies, CSRF, availability, a sandbox checkout and webhook delivery. Do not interpret `/health` alone as database/payment verification.

## Deferred integrations

The initial server configuration used `TURNSTILE_ENABLED=false` at the owner's request. The owner subsequently supplied genuine keys and requested activation; the server now uses **`TURNSTILE_ENABLED=true`**. Booking and contact tokens are verified server-side against the configured hostname and their respective `booking` / `contact` actions. Keep both keys private in the server runtime and restart Passenger after changes. Never insert fake keys on the server. The contact form remains disabled until email setup, as explicitly requested; its endpoint is already protected and no enquiries are stored or sent.

Keep the current Stripe **test mode** during verification. Switching to real payments requires the owner's launch checks, live keys and a live-mode webhook endpoint. Client/admin booking email delivery is Milestone 7. Owner password-reset email requires the existing Resend configuration and a verified sender; production does not write reset links to local files.

Back up MySQL daily through cPanel and retain off-server copies. Keep `SESSION_SECRET` stable between releases: it protects private visit links and encrypted owner TOTP secrets. Deployment documentation is not evidence that an integration passed; record the actual verification results after setup.

## Verified server setup — 17 November 2026

The main domain is running under CloudLinux Node **20.20.2** / Passenger in production mode. The dedicated database has 25 tables including Drizzle migration history, 13 styles and 30 variants. The server `.env` and database credentials are private, outside the web root. The original web root was backed up before cutover.

Verified on the actual hosted site:

- HTTPS home, styles, style detail, Our Work, booking, Pay and owner sign-in; HTTP redirects to HTTPS.
- Real owner login, secure HttpOnly SameSite=Lax cookies, dashboard, bookings, calendar, review and activity history at 390/1440 px. No axe violations, page overflow or JavaScript errors in those checks.
- All image paths in the style manifest respond successfully.
- A real Stripe **sandbox** card checkout charged the $30 test deposit, Stripe's hosted webhook confirmed the booking, and the confirmation page appeared. The test payment was then refunded and its appointment cancelled through bookingService; net test money is zero and no chair remains blocked.
- Five-minute hold/refund cron installed and run successfully.
- Daily database backup at 03:20 server time, with 14-day retention, installed at `/home/madoafri/mado-deploy/backup-database.sh`. The first compressed backup passed its integrity check. Backups live in `/home/madoafri/mado-backups/database`; database credentials are read from a private option file, not command arguments.
- Local build/lint and 145 application tests passed; production dependency audit reports zero known vulnerabilities.

Stripe is still in **test mode**. Turnstile is now enabled with the supplied keys. Booking email delivery remains Milestone 7, and contact messages remain disabled until then. The owner explicitly authorized one off-server database backup download; it is saved in ignored `tmp/hosting/live/database-backup.sql.gz` and passed a local gzip integrity check. No backup contents or credentials are committed. A recurring off-server backup destination still needs configuration.

The logging dependency is pinned to its Node 20-compatible major. `sanitize-html` is retained at the security-patched 2.18.x release because older 2.17.x releases have published vulnerabilities; npm reports its declared Node 22 engine requirement. The current SSR rendering and full application suite run successfully on the project's fixed Node 20 runtime; formal support for that package/runtime combination remains a dependency follow-up.
