# Milestone 3 — availability and holds

The owner corrected the appointment interval to **30 minutes**. The salon has shared capacity for **three concurrent clients**, Mon–Sat 6am–9pm and Sunday 10am–6pm, in America/New_York. Hair with 50% human hair is included; 100% human hair is an optional $40 upgrade. Existing $25 head wash and base style prices are unchanged.

## Delivered

- Four-step `/book` wizard with style/size/length, optional extras, calendar and start-time choices, contact details, optional notes/private inspiration image, required policy acceptance and optional unticked marketing consent.
- Server price quotes and validated month/day availability APIs. Client price fields are rejected. Consultation styles keep their final total unknown and accept only the deposit preference.
- Thirty-minute start grid, service/variant/extra durations, 30-minute buffer, 24-hour notice and 60-day advance window. Service plus buffer must fit opening hours. All instants are stored in UTC and displayed in Eastern time.
- Capacity is calculated from the maximum simultaneous overlap across the entire candidate interval. Staggered starts, live holds, existing bookings and salon-wide time blocks are considered. Fully occupied times are disabled; an entirely full day is disabled in the calendar. Expired holds stop consuming capacity immediately.
- All hold creation passes through bookingService. REPEATABLE READ transactions take date locks before consistent reads and recheck current occupancy with locking reads. Concurrent duplicate-key lock upgrades can deadlock; bounded retries rerun the entire rolled-back transaction.
- A successful request creates an unpaid `pending_payment` hold, not a confirmed booking. Prices and extras are snapshotted with zero paid and the full provisional balance outstanding. The hold expires after 30 minutes. No Stripe session is created.
- Server-side Zod validation, CSRF, hold/availability rate limits, honeypot and configured Turnstile verification. Private image uploads accept JPEG/PNG/WebP by file bytes, limit size to 8 MB and pixels to 40 million, re-encode to WebP, and remove files on failed holds.
- Back/forward and refresh retain choices; contact details stay in browser session storage instead of the URL. Desktop has a sticky summary and mobile an expandable bottom summary. Storage is cleared on successful hold creation.

## Validation

- Build and lint pass; 83 unit/Supertest tests pass.
- Four additional real database integration tests pass in an isolated, randomly named temporary database. Twenty simultaneous HTTP requests commit exactly three holds and return 17 capacity conflicts. Service-level concurrency also verifies capacity three and capacity one. Failed requests leave no partial client/booking records.
- Pricing tests cover tampering, wrong/inactive variants, duplicate/ineligible extras, capped deposits, duration changes and consultation pricing. Availability tests cover staggered overlap, half-open boundaries, holds expiring, buffers, time blocks, hours, notice/advance limits and both 2026 DST changes, including nonexistent/repeated local times.
- Fifteen Chrome/axe cases pass across 390px/1440px: all four steps, the three open selection menus, and expanded mobile summary, with no tested WCAG A/AA violations or horizontal overflow. Grey-out, back/forward, refresh and successful unpaid hold messaging pass. Browser tests use synthetic in-memory data and an ephemeral app port; real appointment data is untouched.
- `npm test` deliberately skips the database suite. Run `npm run test:db` to enable it. The test runner creates and removes only its own `mado_booking_test_*` database, using DATABASE_URL or optional TEST_DATABASE_URL; test credentials need database creation privileges.

## Run locally

Keep the ignored `.env`, start MySQL, then run:

```powershell
npm install
npm run db:migrate
npm run db:seed
npm run content:sync
npm run build
npm run dev
```

Open http://localhost:4780/book. `content:sync` explicitly applies the approved hours, capacity, half-hour starts, hair policy and $40 upgrade; review it before applying it over subsequent owner edits. No schema migration or new application secrets were needed. Existing Turnstile variables enable verification when set. Original design work present before this milestone was preserved.

## Follow-ups

Milestone 4 adds Stripe Checkout, payment confirmation, cancel/resume, expiry state cleanup, and late-payment capacity conflict handling. Confirmation email, full admin workflows and launch checks remain in their later milestones. Individual stylist selection, separate staff calendars and payroll are outside the shared-capacity requirement. Remote deployment still awaits working hosting access; the user chose the main domain rather than a preview domain. This milestone does not deploy the server or process money.

The compact booking introduction now shows a yellow included-hair badge and a policy banner for the $30 USD non-refundable deposit applied to the total. Style, size and length menus support bounded scrolling, touch gestures, mouse hover colours, arrows/Home/End, typeahead, Enter, Escape and outside-click dismissal. Native selects remain the underlying form values. Actual touch scrolling and keyboard selection are included in the browser checks.
