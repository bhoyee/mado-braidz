# Milestone 4 — Stripe payments

Implementation is ready for review. **Real Stripe sandbox-card/CLI acceptance remains pending: the local Stripe keys have not been supplied.** No live charges or remote deployment have been performed.

## Delivered

- Hosted Stripe Checkout for the server-snapshotted deposit or full amount. Consultation styles remain deposit-only. Stripe Dashboard controls available payment methods; sessions charge USD with adaptive conversion and automatic tax disabled.
- Durable checkout attempts with exact expected amounts, payment type, Stripe IDs and expiry. The initial Stripe idempotency key is `hold-<bookingId>`; balance attempts have their own keys. A session-bound unique request key protects repeated hold submissions. Private manage links use a stored SHA-256 token hash.
- Webhook signature verification over raw request bytes before Express JSON parsing and CSRF. Handles paid completion, asynchronous success/failure, expiry and cumulative charge refunds. Unpaid completion never confirms a booking. Event IDs and payment intents prevent duplicate effects.
- Date-locked payment confirmation preserves shared capacity three across the entire service plus buffer. Expired holds can still confirm if capacity is free. If capacity is taken, an idempotent durable refund task is recorded and attempted immediately. A retry after a provider failure resumes the refund without recording the payment twice.
- Deposit/full/balance payment records, net paid amount, outstanding balance, partial/full refund statuses, queued confirmation/conflict email jobs and admin notifications. Actual email delivery remains Milestone 7.
- Cancel/resume expires the open Stripe session before releasing the hold. A race with completed payment redirects to confirmation rather than cancelling the appointment. Browser URL/session state restores the four-step form.
- `/book/success` polls authoritative application status every two seconds for up to 60 seconds. Confirmation shows time, reference, paid amount, balance, directions, calendar download and a private manage link. A redirect or session ID alone does not confirm or reveal a booking.
- Private `/booking/:token` payment summary and exact balance Checkout for eligible deposit-paid appointments. Client cancellation/rescheduling and admin actions remain their later milestones. Consultation balances require a final quote first.
- A cron-safe job runner takes `GET_LOCK('jobs', 0)`, expires unpaid holds and retries pending/failed conflict refunds. It does not consume email jobs yet.

## Migration and configuration

`0002_amazing_ezekiel_stane.sql` adds `checkout_attempts` and a nullable unique booking checkout-request key. Existing appointments and prices are preserved. There are now 22 tables.

Existing Stripe variables are used: STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY and STRIPE_WEBHOOK_SECRET. Local/test environments require matching sandbox key modes and reject live credentials. Production retains the existing HTTPS/secret validation. No new application environment variables were added. Keys, webhook secrets and private tokens are not committed or printed. Private URL credentials are masked in request logs.

Stripe requires session expiry at least 30 minutes after request receipt. A **ten-second transport allowance** is included when reserving the session, with the application hold matched to the returned Stripe expiry. A failed ambiguous request retains the same attempt/idempotency key for retry. Expired holds stop consuming capacity immediately; cron subsequently changes their stored status.

On cPanel, run `node scripts/run-jobs.js` from cron every five minutes using the host's Node 20 executable. This is a short-lived task, not a background worker. README contains the migration, manual Stripe CLI forwarding and deployment commands; local app URL remains http://localhost:4780.

## Validation

- Build and lint pass.
- 104 unit/Supertest tests pass, including signed raw webhooks without CSRF, bad signatures, duplicate/replayed payment events, unpaid completion, asynchronous payment, deposit/full/balance, amount/currency/metadata tampering, expired/late holds, capacity-conflict refunds with provider retry, partial/full and out-of-order refunds, cancellation races and private status access.
- Six real database tests pass in a disposable database: the earlier 20-request capacity tests plus concurrent webhook/payment/job deduplication and a persisted late-payment conflict/refund.
- Mobile/desktop payment browser checks pass with a **mock Stripe provider**: redirect handoff, cancel/resume, confirmation, private balance checkout, calendar link and tested WCAG A/AA checks. This does not substitute for a real Stripe sandbox payment.
- The existing 17-case booking browser suite is retained.
- `npm run test:stripe:e2e` is prepared for a real hosted sandbox card test through Stripe CLI. It refuses live keys, uses a disposable local database and ephemeral test listener, passes keys through environment variables, and closes its own browser/listener afterward. With the supplied sandbox keys, real Checkout creation and the hosted handoff have been verified. Automated hosted-card completion remains pending because the current Stripe page does not expose the expected Pay control.

## Follow-ups

Add the matching test keys to ignored `.env`, then complete the real Stripe CLI/card verification. Review the final sandbox Checkout payment methods and merchant branding in Stripe Dashboard. Keep this PR a draft until that external acceptance passes. Live keys, owner test bookings, full launch checks and deployment remain later work. Email delivery, admin payment/refund controls, staff permissions and appointment changes remain Milestones 5–7. Hosting still awaits working SSH access.

References: [Stripe Checkout sessions](https://docs.stripe.com/api/checkout/sessions/create), [webhook handling](https://docs.stripe.com/webhooks), [refunds](https://docs.stripe.com/api/refunds/create).
