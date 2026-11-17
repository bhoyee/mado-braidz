# Milestone 5 — Owner admin core

Owner-only, as requested. Open `http://localhost:4780/admin` and sign in with the seeded `ADMIN_EMAIL` / `ADMIN_PASSWORD` from the ignored development `.env`. Existing database credentials remain authoritative: editing `.env` alone does not reset an existing owner's password.

## Included

- Session login, argon2id passwords, account-level five-failure / 15-minute lockout plus IP rate limiting, eight-hour sessions, logout and password resets. Staff records are refused; there is no staff-management screen.
- Optional authenticator TOTP, encrypted at rest using a key derived from `SESSION_SECRET`, with one-use time steps. Password changes and two-factor changes revoke existing owner sessions. Password resets preserve an enabled authenticator.
- Dashboard with today's/tomorrow's appointments, active holds, net receipts this week/month, balances and bookings created since last sign-in.
- FullCalendar day, week and month views in America/New_York. Dragging asks for confirmation and whether to queue a client update. Failed or stale moves revert. The booking editor is the keyboard/mobile alternative.
- Searchable and filterable bookings with pagination and CSV export, including spreadsheet-formula escaping.
- Booking detail, contacts, original style/price snapshot, payment timeline, private inspiration images, private owner notes, audit and email history, and a copyable private visit/payment link.
- Edit client details, date, time, notes, style and extras; set a consultation's agreed total. Rescheduling preserves the price unless a style/extra change is explicitly selected. Refund first if a new total would fall below net money already paid.
- Confirm with an explicit unpaid owner override, cancel, mark completed/no-show, record received payments, queue balance/confirmation emails and request partial/full refunds. Booking cancellation and refund remain separate actions.
- Owner-created appointments with a temporary deposit-payment hold, recorded in-person payment, or a clearly labelled unpaid override. Override appointments can pay their full known balance through their private visit link or `/pay`.
- Zelle/Cash App reviews now live inside the session-authenticated owner portal. The default live application no longer uses the old Basic-auth review bridge.

All booking mutations enter `bookingService.js`. Reschedules lock old and new calendar dates in sorted order, exclude the appointment itself from overlap counts, and recheck duration, buffer, time blocks and capacity. Open card attempts, pending proof reviews or outstanding refunds prevent conflicting edits. Cash receipts use durable unique request keys. Stripe refunds use durable jobs and idempotency keys; shared Pay-all charges refund only the selected booking's allocation. Manual refunds record money the owner has already returned; they do not send Zelle/Cash App transfers.

## Run and deploy

```powershell
npm install
npm run db:migrate
npm run build
npm run dev
```

Port remains **4780**. Migration `0005_broken_mandroid.sql` adds owner-auth state and a unique owner-payment request key; it does not replace existing booking data. Production still uses Passenger and the existing cron job for refund retries. Install/build locally before deployment; the calendar bundle is committed under `public/build` and loaded only on the calendar page.

No new env variables. Keep `SESSION_SECRET` stable: changing it invalidates sessions and private booking links and makes existing encrypted TOTP secrets unreadable. For production password resets, configure the existing `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` and verified `EMAIL_FROM`. Local development with log email mode writes the single-use reset URL to ignored `tmp/admin/password-reset.txt`, never public HTML or application logs. Reset links expire after 30 minutes; production has no file fallback. Keep the authenticator backed up; lost-device recovery is a verified maintenance task, not an unauthenticated reset that disables two-factor.

## Verification

```powershell
npm run build
npm run lint
npm test
npm run test:db
npm run test:admin:browser
```

Validated: build and lint; 144 application tests; all 10 disposable-MySQL integration tests; owner browser checks at 390/1440 px with zero axe violations or page overflow; actual desktop calendar dragging and its confirmation dialog; the existing combined-payment browser journey; and sign-in/dashboard/bookings/history/review against the real local owner database. The browser harness uses generated test credentials, fake Stripe, an in-memory repository and an ephemeral port. It does not touch development bookings or take money. It checks login, creation, date/time edits, the unpaid-override balance link, owner screens, overflow, axe accessibility and CSP errors. MySQL tests create and remove only their own randomly named disposable database; they include simultaneous owner moves and repeated cash receipt submission. The local owner sign-in check records only its authentication audit; it does not change appointments.

## Follow-ups

- Staff accounts and staff-management UI are deferred by owner instruction.
- Catalog CRUD, availability settings and time-block editing are Milestone 6.
- Delivery of client confirmations, reschedule messages, payment receipts and balance-link emails remains Milestone 7. Requests are queued; copy the private visit link when a client needs it now.
- Hosted Stripe test-card confirmation and remote deployment passed on 17 November 2026; see [DEPLOY.md](DEPLOY.md). Owner launch testing and live Stripe activation remain outstanding.
