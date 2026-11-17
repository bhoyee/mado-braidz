# Hosting preview

**Historical record.** SSH access and main-domain deployment were completed on 17 November 2026. See [DEPLOY.md](DEPLOY.md) for current setup and verification; the blocked-access notes below describe the earlier state.

The owner has chosen deployment to the main domain, madoafricanbraidz.com. These earlier hosting checks remain recorded for troubleshooting; do not create a preview subdomain. Milestone 3 now includes availability and unpaid temporary holds; Stripe payment and confirmation remain unfinished.

## Access check — 16 November 2026

- The supplied address is the domain's HTTPS cPanel endpoint on port 2083.
- HTTPS certificate validation succeeds, but both API requests and local Chrome remain on the host's browser-verification screen. Authentication could not be verified.
- SSH connections to the domain on port 22 are refused. The provider may use a separate hostname or port; this has not been confirmed.
- The main domain currently serves an Under Construction page. No remote files, databases, DNS records or application settings have been changed.
- Node.js, Passenger, database version and account limits remain unverified.

The local `server_username`, `server_password` and `server_url` values are deployment credentials only. Keep them in the ignored local `.env`; do not upload that file or add these credentials to the application's runtime environment.

## Review deployment plan

1. Confirm cPanel access and Node.js application support (CloudLinux Setup Node.js App or cPanel Application Manager). Confirm the specified Node 20 runtime and MySQL 8 / MariaDB 10.6+ are available.
2. Use the main domain with HTTPS, as instructed by the owner. Preserve its existing files and configuration before cutover.
3. Create a separate server database and database user with access only to that database. Use the actual cPanel-prefixed names in DATABASE_URL; local root credentials do not apply on the host.
4. Extract the verified release outside the public document root. Configure Passenger's application root and startup file `src/server.js`. Install Linux dependencies using the selected runtime and `npm ci --omit=dev`; never upload Windows node_modules.
5. Set server-specific configuration through the hosting panel: HTTPS APP_URL, NODE_ENV=production, a new random SESSION_SECRET, database credentials, persistent absolute LOG_DIR and UPLOAD_DIR paths, and owner seed credentials. Keep the local PORT=4780; use the host's Passenger configuration for remote routing.
6. Resolve the current production-config gate before starting: `src/config/env.js` requires Stripe, Turnstile and cron secrets in production even though those features are later milestones. Do not use fabricated keys or development mode to bypass this. Configure valid credentials or implement an explicit, tested preview configuration once the hosting target is confirmed.
7. Run `npm run db:migrate` and `npm run db:seed` against the new database. New databases receive the latest approved opening hours and public copy. `npm run content:sync` explicitly overwrites hours/About copy, so use it on an existing database only when that update is intended.
8. Restart through Passenger. Verify HTTPS home, `/health`, `/styles`, a size/length page, `/our-work`, images, fonts and video. Confirm session cookies are secure, the design preview is protected, and no secrets or source files are exposed through the web server.

Milestone 3 adds availability and unpaid temporary holds. Payments, contact delivery, jobs and full admin features remain unfinished. Do not configure live payment webhooks or advertise online booking as operational.

## Local release preparation

Build, lint and all 66 unit/Supertest tests passed on 16 November 2026. The ignored `tmp/hosting/mado-preview.zip` is a snapshot of the current working files, including the local design edits. It includes prepared public assets and `.env.example`, and excludes `.env`, Git metadata, dependencies, logs, uploads and original design media. A SHA-256 checksum is saved alongside it. This archive is prepared locally; it has not been uploaded or deployed.

Repeat verification and regenerate the archive whenever the working files change. Remote runtime, database and browser checks are still required after access is restored.

References: [cPanel Node.js deployment](https://docs.cpanel.net/knowledge-base/web-services/how-to-install-a-node.js-application/) and [CloudLinux Node.js application setup](https://support.cpanel.net/hc/en-us/articles/1500000004602-How-to-create-a-NodeJS-application-via-CloudLinux).

The local archive has been refreshed with the Milestone 3 working files and latest assets; no upload or remote deployment has been performed. See MILESTONE-3.md for current verification results.
