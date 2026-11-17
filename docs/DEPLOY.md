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

The owner explicitly requested bringing up the current application before adding Turnstile. The initial server configuration therefore uses **`TURNSTILE_ENABLED=false`**, while keeping production mode, HTTPS, CSRF, rate limits and the honeypot. The code default remains true. Later add genuine `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY`, set the flag true and restart Passenger. Never insert fake keys to satisfy validation.

Keep the current Stripe **test mode** during verification. Switching to real payments requires the owner's launch checks, live keys and a live-mode webhook endpoint. Client/admin booking email delivery is Milestone 7. Owner password-reset email requires the existing Resend configuration and a verified sender; production does not write reset links to local files.

Back up MySQL daily through cPanel and retain off-server copies. Keep `SESSION_SECRET` stable between releases: it protects private visit links and encrypted owner TOTP secrets. Deployment documentation is not evidence that an integration passed; record the actual verification results after setup.
