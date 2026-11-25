# Mado African Braidz — Product Build Spec for Codex

Nov 15, 2026 · @bola

## 0. How to use this doc with Codex

Don't paste the whole doc into a single prompt. Export it as Markdown and commit it to the repo, so Codex reads it as the source of truth every session.

1. Create an empty Git repo `mado-braidz`.
2. Export this doc as Markdown and save it as `docs/SPEC.md`.
3. Create `AGENTS.md` at the repo root with the block below. Codex reads `AGENTS.md` automatically.
4. Run one milestone per Codex task (Section 13). Review, test locally, merge, then start the next.
5. Settle the open decisions in Section 2 with the owner before Milestone 3 (booking + payments).

```markdown
# AGENTS.md
You are building the Mado African Braidz booking platform.
The full product spec is docs/SPEC.md. Read it before every task. It wins over your assumptions.

Rules:
- Stack is fixed: Node.js 20 LTS, Express 4, Nunjucks SSR, Tailwind CSS v4 (built at build time), Alpine.js, MySQL 8 via Drizzle ORM + mysql2, Stripe Checkout + webhooks. No Next.js, no React SPA, no Redis, no Docker in production.
- Target host is shared cPanel hosting (Phusion Passenger). No long-running workers; background work runs from cron via `node scripts/run-jobs.js`.
- All money is stored as integer cents. All times stored in UTC; displayed in America/New_York.
- Never trust prices from the client. Always recompute totals on the server.
- Every booking state change goes through `src/services/bookingService.js`.
- Write tests (Vitest + Supertest) for booking, slot locking, pricing and webhooks.
- Follow the design system in docs/SPEC.md Section 4. Do not use generic template layouts, gradient blobs, glassmorphism, emoji icons, or stock "three feature cards" sections.
- Work only on the milestone you're given. List anything out of scope under "Follow-ups" in your summary.
- Update README.md (setup, env vars, deploy steps) whenever you add config.
```

## 1. Product overview

This is a premium, brand-led website and booking platform for an African hair braiding salon with capacity for three concurrent clients in Lanham, MD. Clients browse styles, pick a time, add extras, and pay a $30 deposit or the full price through Stripe. A temporary hold consumes capacity during checkout; payment confirmation makes the booking permanent. The owner runs everything from an admin portal and gets alerts by email and in-app.

### Business facts

| Field | Value |
| --- | --- |
| Public brand name | Mado African Braidz (confirm, see Section 2) |
| Domain | https://madoafricanbraidz.com |
| Address | 7375 Executive Place, Lanham, MD 20706 (confirm suite number) |
| Phone | (443) 743-4979, stored as +14437434979 |
| Timezone | America/New\_York |
| Currency | USD |
| Default appointment length | 4 hours, editable per style |
| Booking deposit | $30, applied toward the total |
| Head wash add-on | $25 |
| Concurrent capacity | 3 clients throughout the appointment and buffer; individual staff selection is not part of this amendment |
| Hair | 50% human hair included; optional 100% human hair upgrade +$40 |
| Hours | Monday–Saturday 6am–9pm; Sunday 10am–6pm (America/New_York) |

### Goals for v1

1. Visitors find the salon on Google for searches like "knotless braids Lanham MD" and see every style with clear prices.
2. Visitors book and pay in under 2 minutes on a phone, with no account required.
3. Never exceed three concurrent clients. Each paid booking consumes one capacity unit for its full duration and buffer.
4. The owner manages bookings, styles, prices, availability and settings herself, with no developer.
5. Automated emails cut no-shows (reminders) and bring clients back (win-back at 1, 2 and 3 months).

### Out of scope for v1

- Client accounts with passwords (clients use magic links from their emails instead)
- SMS (design the notification layer so Twilio can plug in later)
- Individual staff selection, staff calendars and payroll (shared capacity of three is included)
- Product shop and gift cards

## 2. Open decisions to confirm with the owner

Each of these has a working default, so Codex can build now. They're all settings in the admin, so changing one later doesn't need new code.

| # | Question | Default used in the build |
| --- | --- | --- |
| 1 | Brand name. The logo says "Mado Braids", the flyer says "Mado Hair Braiding", the domain says "Mado African Braidz". Which one goes public? | "Mado African Braidz" everywhere. One name matters for Google (name, address and phone must match exactly). |
| 2 | Is the $30 deposit taken off the total, or charged on top as a booking fee? | Taken off the total |
| 3 | Is the deposit refundable? What's the cancel/reschedule window? | Non-refundable. One free reschedule if made 48h+ before. Late cancel or no-show forfeits the deposit. |
| 4 | Business hours and start times | Owner confirmed Mon–Sat 6am–9pm; Sun 10am–6pm. Starts every 30 minutes; capacity 3. |
| 5 | Buffer between clients | 30 minutes |
| 6 | How far ahead can people book? Minimum notice? | Up to 60 days ahead, at least 24h notice |
| 7 | Is hair included, or does the client bring hair? | Hair with 50% human hair is included; 100% human hair upgrade adds $40 |
| 8 | How is the balance paid? | Client chooses: online card link (Stripe) or in person (cash, Zelle, card). Admin records in-person payments. |
| 9 | Prices for "Other styles" (cornrows, passion twist, etc.) | Shown as "Price on consultation" with a "from" price the admin can set |
| 10 | Sales tax on services | Off (MD generally doesn't tax personal services; owner's accountant should confirm) |
| 11 | Suite or unit number | None until confirmed |
| 12 | Real photos of her own work | Required before launch. The flyer photos look AI-generated, which goes against the premium, real-salon feel and can hurt trust. |
| 13 | Logo vector files | Logo needs redrawing as a clean SVG. The current file is a phone photo of a screen. |
| 14 | Email sender | bookings@madoafricanbraidz.com, sent through Resend or Postmark with SPF, DKIM and DMARC set up |

## 3. Tech stack and shared-hosting architecture

The stack is a server-rendered Express app on MySQL. It suits shared hosting best: low memory, no build step on the server, and full HTML for search engines. Next.js and React SPAs are deliberately out. On shared cPanel hosts they hit memory limits and make the build painful.

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 20 LTS through cPanel "Setup Node.js App" (Passenger) | Standard on shared hosts |
| Web framework | Express 4 | Stable, light, Passenger-friendly |
| Views | Nunjucks templates (SSR) | Full HTML for SEO, fast first paint |
| Styling | Tailwind CSS v4, compiled locally or in CI, output committed to `public/build` | No Node build on the server |
| Interactivity | Alpine.js plus small vanilla modules (booking wizard, admin calendar) | Under 20 KB of JS on public pages |
| Admin calendar | FullCalendar (standard, MIT) loaded only on admin pages | Day, week and month views, drag to reschedule |
| Database | MySQL 8 / MariaDB 10.6+ (what cPanel provides) | Included with the host |
| ORM and migrations | Drizzle ORM + drizzle-kit + mysql2 | Pure JS, no native binary (Prisma engines often fail on shared hosts) |
| Sessions | express-session + express-mysql-session | No Redis needed |
| Validation | Zod | One schema for forms and the API |
| Payments | Stripe Checkout (hosted) + webhooks, Stripe Node SDK | Card, Apple Pay, Google Pay, Cash App Pay, Link. Keeps the site out of most PCI scope. |
| Email | Resend (or Postmark) API with MJML templates compiled to HTML | Host SMTP mail often lands in spam |
| Admin push | Web Push (VAPID) via `web-push`, with the admin installable as a PWA | Phone alerts with no app store |
| Images | `sharp` resizes uploads into AVIF/WebP at 480, 960 and 1600 px | Speed. Fall back to the original upload if sharp won't load on the host. |
| Jobs | `jobs` table + cPanel cron every 5 min running `node scripts/run-jobs.js` | Shared hosts kill long-running workers |
| Logs | pino to a rotating file under `~/logs` | Debugging on the host |
| Tests | Vitest + Supertest + Stripe CLI for webhook testing |  |

### Folder layout

```text
src/
  app.js                # express app (exported for tests)
  server.js             # entry for Passenger (app.listen)
  config/               # env loading with zod validation
  db/schema.js          # drizzle schema
  db/migrations/
  routes/public/        # home, styles, booking, policies, contact
  routes/admin/         # dashboard, bookings, calendar, styles, settings
  routes/webhooks/stripe.js
  services/
    bookingService.js   # ALL state changes
    availabilityService.js
    pricingService.js
    paymentService.js   # stripe calls
    notificationService.js
    emailService.js
  jobs/                 # reminder, winback, expireHolds, cleanup
  views/                # nunjucks: layouts, partials, pages, emails
  middleware/           # auth, csrf, rateLimit, security headers
public/                 # build/, fonts/, img/, manifest.webmanifest, sw.js
scripts/run-jobs.js     # cron entry
scripts/seed.js         # seeds styles, add-ons, settings, admin user
uploads/  (outside webroot, symlinked or served by route)
```

### Shared-hosting rules for Codex

- The Stripe webhook route must use `express.raw({ type: 'application/json' })` and be mounted before `express.json()`.
- No WebSockets or SSE (Passenger buffering breaks them). Admin in-app alerts poll `/admin/api/notifications?since=` every 30 s, plus Web Push.
- Read all secrets from env vars set in the cPanel Node.js app panel. Ship `.env.example`.
- `app.set('trust proxy', 1)` so secure cookies and rate limiting work behind the host's proxy.
- Store uploads outside the deploy folder so redeploys don't wipe them.
- The cron job takes a MySQL `GET_LOCK('jobs', 0)` so runs never overlap.

## 4. Brand and UI/UX direction

The look is an editorial salon magazine: warm black and bone backgrounds, the logo's magenta and copper used sparingly, big real photography of braids, and confident serif type. It should feel like a boutique studio, not a template. The braided ring in the logo is the signature motif.

### Palette (owner decision, Nov 2026: purple-led)

The owner asked for purple as the brand colour; it also matches the purple ring on the studio sign. This replaces the original magenta/copper palette. Solid colours only, never gradients.

| Token | Hex | Use |
| --- | --- | --- |
| `night` | #1C0F26 | Deep aubergine: hero, price menu, footer; body text on light |
| `plum` | #2E1640 | Dark surfaces and cards on night |
| `violet` | #7B3FC4 | Primary: buttons, links, focus rings, selected states. White text on it is 6.3:1. |
| `violet-deep` | #5F2D9E | Hover, eyebrow labels, prices on light, closing band |
| `lilac` | #CDB6F2 | Accent text on dark (italic heading words, labels) |
| `mist` | #F4EEFB | Soft lilac panels, page headers |
| `cream` | #FBF7F2 | Main light background (never pure white) |
| `linen` | #F2EBE2 | Alternate warm panels |
| `gold` | #E0B26A | Prices and hairlines on dark only |
| `magenta` | #C8146E | Logo only |
| `success` / `danger` | #2F7D4F / #B3261E | System states |

Rule: warm neutrals and photography carry most of each page; violet is the action colour; dark plum sections give rhythm. Signature shape: the arch (from the studio's arched mirrors) on hero, style and film frames, plus the braided ring stamp.

### Typography

- Display: **Fraunces** (variable, SOFT axis at 100) for headings and big price figures; italic for one accent phrase per heading.
- Body and UI: **Figtree** for text, buttons and forms.
- The script "Mado" lives only in the logo SVG. Don't use a script font for headings.
- Self-host both as WOFF2 subsets with `font-display: swap`. Preload the display font.
- Body is 17 px on mobile and 18 px on desktop. Display scale: 22–30, 34–60, 44–112 px (fluid). Headings get tight tracking (-0.02em); small caps labels get wide tracking (0.14em, uppercase, 12 px), like "BRAIDS" in the logo.

### What makes it look hand-made, not AI-generated

- Real photos of her clients, shot on one consistent backdrop with warm light. Portrait crops (4:5), not square stock.
- Asymmetric editorial layouts: a large photo bleeding off one edge with text offset, numbered sections (01, 02, 03), and generous whitespace.
- A price menu laid out like a printed salon menu (style name, dotted leader, price) instead of pricing cards.
- The braid ring from the logo, redrawn as SVG, used as: a loading spinner, a section divider, a stamp on the confirmation page, and the favicon.
- Subtle motion only: 200–300 ms fades and image reveals on scroll, respecting `prefers-reduced-motion`. No parallax, no bouncing.
- Microcopy in her voice ("Your chair is booked" instead of "Booking successful").
- Banned: purple gradients, glass cards, blob shapes, emoji, icon-in-a-circle feature rows, generic "Why choose us" grids, stock-photo heroes, centered-everything layouts.

### Components to build (in a design-system page at `/admin/design`, visible only to admins)

Buttons (primary magenta, secondary outline ink, ghost), style card, price menu row, length selector chips, add-on toggle card, calendar date grid, time slot pill (available, selected, unavailable), booking summary panel (sticky on desktop, bottom sheet on mobile), form fields with inline errors, status badge, toast, empty state, modal, admin data table.

### UX rules

- Mobile first. Most clients come from Instagram on a phone. Design at 390 px wide, then scale up.
- A sticky "Book now" button on every public page on mobile.
- Tap targets at least 44 px. Forms use the right input types and autocomplete (`tel`, `email`, `name`).
- Accessibility: WCAG 2.2 AA, visible focus rings in copper, alt text on every photo, keyboard-usable booking wizard.
- Show prices up front, including the deposit and what's due on the day. No surprises at checkout.

## 5. Public site pages and booking flow

The public site has 10 page types, all server-rendered. The booking wizard runs in 4 steps at `/book` and ends in Stripe Checkout.

### Pages

| Route | Purpose | Key content |
| --- | --- | --- |
| `/` | Home | Hero with a real photo and a "Book your chair" button, signature styles (6), the price menu preview, how booking works (deposit explained), gallery strip, reviews (embedded from Google, real only), location map, FAQ teaser |
| `/styles` | All styles | Filter by category (Knotless, Boho, Twists, Locs, Fulani, Other). Each card shows a photo, a "from" price and a link. |
| `/styles/:slug` | One style (SEO landing page) | Gallery, description, price table by size and length, duration, what to expect, hair advice, FAQ, "Book this style" button that prefills the wizard |
| `/prices` | Full price menu | The whole flyer as an accessible HTML menu |
| `/book` | Booking wizard | Steps below |
| `/book/success` | After payment | "Confirming your booking..." that polls status, then shows the confirmation, add-to-calendar (.ics), directions |
| `/booking/:token` | Manage booking (magic link) | View details, pay balance, reschedule or cancel within the policy |
| `/gallery` | Portfolio | Masonry of real work, tagged by style |
| `/about` | Her story | Photo, story, credentials |
| `/contact` | Visit | Address, map, hours, phone (click to call), Instagram, contact form |
| `/policies`, `/privacy`, `/terms` | Legal | Deposit, cancellation, lateness, hair prep, privacy |
| `/areas/:town` | Local SEO pages (Section 11) | Bowie, Greenbelt, Largo, Hyattsville, etc. Unique copy each. |

### Booking wizard

1. **Style.** Pick a style, then size (Medium, Semi-Medium, Small) and length (Shoulder, Mid Back, Waist, Top Butt, Under Butt). Only valid combinations show, each with its price.
2. **Add-ons.** Toggle cards: Head wash +$25 and 100% human hair upgrade +$40 (seeded). Hair with 50% human hair is already included; never charge that base hair again. Admin can add more (beads, take-down).
3. **Date and time.** Month calendar showing only days with free starts. Pick a start time. Each pill shows start and end ("8:00 AM – 12:00 PM").
4. **Your details and payment.** Name, US phone number (reject non-US numbers with “Invalid phone number”), email, notes, optional inspiration photo, policy checkbox (required), marketing emails checkbox (optional, unticked). Choose **Pay $30 deposit now** or **Pay in full now**. The summary shows: style price, add-ons, total, paid today, due at appointment.

The button "Continue to secure payment" creates the hold and redirects to Stripe Checkout. The summary panel stays visible through every step. State lives in the URL query plus `sessionStorage`, so the back button and refresh work.

### Edge cases the UI must handle

- Slot reaches capacity while the client was filling in the form: show "That time is now fully booked" and the nearest free times.
- Client returns from Stripe with "Cancel": return to step 4 with everything filled in. Release the hold right away.
- Payment succeeded but the webhook is slow: the success page polls `/api/bookings/:ref/status` every 2 s for up to 60 s, then shows "We've got your payment; confirmation is on its way by email."

## 6. Booking engine, slot locking and Stripe payments

The slot is held for 30 minutes while the client pays. It becomes a confirmed, blocked booking only when Stripe's webhook says payment succeeded. A database lock per calendar day enforces the shared capacity of three, even when requests arrive simultaneously. Each valid pending hold consumes one unit; expired holds do not.

### Booking states

| `status` | Meaning | Blocks the calendar? |
| --- | --- | --- |
| `pending_payment` | Hold created, client is at Stripe | Yes, until `hold_expires_at` |
| `confirmed` | Deposit or full payment received | Yes |
| `completed` | Appointment done (admin marks it) | Yes (it's in the past) |
| `cancelled` | Cancelled by client or admin | No |
| `no_show` | Client didn't come | No |
| `expired` | Hold ran out without payment | No |
| `payment_conflict` | Paid after the hold expired and the slot was taken; auto-refunded | No |

Separate `payment_status`: `unpaid`, `deposit_paid`, `paid_in_full`, `refunded`, `partially_refunded`.

Allowed transitions live in one map in `bookingService.js`. Any other transition throws.

### Availability

- Settings hold weekly hours per weekday (open, close, closed flag), slot step (30 min), capacity (3 concurrent clients), buffer (30 min), min notice (24 h), max advance (60 days).
- A start time is offered when `[start, start + duration + buffer)` fits inside opening hours, never exceeds capacity three during any part of the candidate interval, avoids admin time blocks, and passes notice and advance rules.
- Duration comes from the style (default 240 min) plus any add-on durations (head wash: +0 by default, editable).
- Compute in America/New\_York with Luxon, store UTC. Test daylight-saving days (8 Mar 2026 and 1 Nov 2026 style cases).
- `GET /api/availability?styleVariantId=&addonIds=&month=2026-12` returns days with free starts. `GET /api/availability/day?date=` returns start times.

### Creating a hold (the capacity guard)

Inside one MySQL transaction (`REPEATABLE READ`):

1. `INSERT IGNORE INTO calendar_locks (date) VALUES (?)` for every local date the appointment touches, then `SELECT ... FROM calendar_locks WHERE date IN (...) FOR UPDATE`. This serializes all bookings for that day.
2. Re-run the capacity check against bookings with `status IN ('confirmed','completed')` or (`status = 'pending_payment'` and `hold_expires_at > NOW()`), plus time blocks. Use a sweep of start/end events over the candidate interval: the peak existing occupancy must remain below capacity, not merely the total number of intersecting bookings. Process endings before starts at equal instants (half-open intervals). Admin time blocks close the salon for their whole interval.
3. If clear: insert the booking as `pending_payment` with `hold_expires_at = now + 30 min` and a server-computed price snapshot. Commit.
4. If not clear: roll back and return `409 SLOT_TAKEN` with the next 3 free starts.

Then create the Stripe Checkout Session (outside the transaction) and save its id on the booking.

### Stripe Checkout session

- `mode: 'payment'`, one line item built with `price_data` from the server-side price (never from the client).
- Deposit name: "Booking deposit – Knotless Braids, Medium, Waist Length (applied to your total)". Full: "Knotless Braids, Medium, Waist Length + Head wash".
- `expires_at`: now + 30 minutes (Stripe's minimum), matching the hold.
- `customer_email`, `client_reference_id = booking.id`, and `metadata { bookingId, paymentType: 'deposit' | 'full' | 'balance' }` on both the session and `payment_intent_data`.
- `success_url: /book/success?session_id={CHECKOUT_SESSION_ID}`, `cancel_url: /book?resume=<ref>`.
- Payment methods come from the Stripe Dashboard (cards, Apple Pay, Google Pay, Link, Cash App Pay).
- Pass an idempotency key (`hold-<bookingId>`) when creating the session.

### Webhook `POST /webhooks/stripe`

- Verify the signature with `STRIPE_WEBHOOK_SECRET` on the raw body.
- Store every event id in `stripe_events` (unique). Skip duplicates, so retries are safe.
- Handle: `checkout.session.completed` (only act when `payment_status === 'paid'`), `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`.
- On paid deposit or full: open the same day-lock transaction. If the booking is still `pending_payment` and the slot is still free (even if the hold expired a moment ago), set `confirmed` and the payment status, and record a `payments` row. Then queue emails and the admin notification.
- If the slot has gone to someone else: mark `payment_conflict`, refund in full through Stripe, and email the client (apology + rebook link) and the admin.
- On `paymentType: 'balance'`: set `paid_in_full` and record the payment.
- On `checkout.session.expired`: set `expired` if still pending.
- Return 200 quickly. Heavy work (emails) goes to the jobs table.

### Pricing rules (`pricingService.js`)

- `subtotal = variant.price + sum(addon prices)`; `deposit = min(settings.depositCents, subtotal)`.
- Pay deposit: charge today = deposit, balance = subtotal - deposit. Pay in full: charge today = subtotal, balance = 0.
- Save a price snapshot (lines, subtotal, deposit, paid, balance) on the booking, so later price changes never alter existing bookings.
- Optional setting: Stripe processing fee passed to the client. Off by default.

### Balance, refunds, reschedules

- **Balance online:** the manage-booking page and the admin both create a balance Checkout Session for the exact remaining amount.
- **Balance in person:** admin clicks "Record payment" (cash, Zelle, Cash App, card terminal, other) with amount and note. It writes a `payments` row with `provider = 'manual'`.
- **Mark completed:** admin can complete with a balance still due (it flags as "owes $X") or after it's paid. Completing schedules the win-back emails.
- **Refunds:** admin can refund all or part of any Stripe payment from the booking page (calls the Stripe Refunds API, then records it).
- **Reschedule:** same lock logic for the new time; the old time is freed in the same transaction. Clients can do it from the magic link only inside the policy window.
- **Cancel:** frees the slot; the deposit refund follows the policy setting (admin can override).

## 7. Admin portal

The admin portal lives at `/admin`, works well on a phone, and installs to the home screen as a PWA so the owner gets push alerts. It's server-rendered with the same design system, using a calmer dark-on-bone dashboard style.

### Access and roles

- Email + password login (argon2id hashing), optional TOTP two-factor (strongly suggested for the owner), 5 failed attempts per 15 min lockout, password reset by email.
- Roles: `owner` (everything) and `staff` (bookings and calendar only, no settings or refunds). v1 seeds one owner.
- Every change to bookings, prices or settings writes to `audit_log` (who, what, before, after, when).

### Screens

| Screen | What she can do |
| --- | --- |
| Dashboard | Today's and tomorrow's appointments, new bookings since last visit, money taken this week and month, balances owed, upcoming holds |
| Calendar | Day, week and month views. Colour by status. Click a booking for details. Drag to reschedule (same lock rules, asks to email the client). Click empty space to block time or create a booking. |
| Bookings list | Search by name, phone, email or reference. Filter by date, status, payment status. Export CSV. |
| Booking detail | Client details, style, add-ons, notes, inspiration photo, price snapshot, payments timeline, email log. Actions: confirm, reschedule, cancel, mark completed, mark no-show, record payment, send balance link, refund, resend confirmation, add private note. |
| New booking (for a client) | Same steps as the public wizard. Payment options: send Stripe payment link by email, record deposit or payment taken in person, or no payment (admin override, labelled). Option to block the slot immediately. |
| Clients | Profile per client (matched by email, then phone): visits, total spent, last style, notes, marketing consent, win-back status. |
| Styles | Create, edit, archive, reorder styles. Fields: name, slug, category, short and long description, photos (drag to reorder, alt text required), duration, "price on consultation" flag, "from" price, SEO title and description, featured flag. Variants table: size × length × price (add, edit, remove rows; turn a variant off). |
| Add-ons | Create, edit, archive. Name, price, extra duration, which styles it applies to (all by default), active flag. Head wash $25 is seeded. |
| Availability | Weekly hours, closed days, holidays and time blocks (one-off or repeating), slot step, buffer, min notice, max advance. |
| Gallery | Upload and tag photos by style. Photos are auto-resized. |
| Notifications | Bell with unread count (polls every 30 s), list of events, "Enable push on this device" button. |
| Settings | Business name, address, phone, hours text, social links. Deposit amount. Hold minutes. Cancellation policy text and refund rules. Balance options shown to clients. Email toggles and timing (reminders, win-back). Admin alert email addresses. Stripe mode indicator (test or live). |
| Email templates | Edit subject and intro paragraph for each email (the layout stays locked to keep the brand). Send a test to yourself. |
| Team | Invite staff, reset passwords, turn on two-factor. |

### Price changes

Changing a price affects only new bookings. Existing bookings keep their snapshot. The style editor shows "Last changed by X on date".

## 8. Notifications and email lifecycle

All emails go through a `jobs` queue with a `run_at` time, so cron sends them on schedule and failures retry. Reminder and win-back jobs check the booking's current state before sending. A cancelled or rebooked client never gets a stale email.

### Client emails

| Email | When | Content |
| --- | --- | --- |
| Booking confirmed | Right after the webhook confirms | Style, date and time, duration, address with map link, amount paid, balance due, prep tips (come with hair washed and detangled, unless head wash added), policy, manage-booking link, .ics attachment |
| Reminder 1 | 48 h before | Details, balance due, prep checklist, reschedule link (if inside the policy window) |
| Reminder 2 | Morning of, 7:00 AM local | Short: time, address, parking note, phone |
| Thank you + review | 3 h after marked completed | Thanks, care tips for the style, link to leave a Google review |
| Balance receipt | On balance payment | Receipt with totals |
| Rescheduled / Cancelled | On change | New details or cancellation and refund info |
| Payment conflict | Auto-refund case | Apology, refund confirmation, priority rebook link |
| Win-back 1 | 30 days after completed | "Time for a refresh?" with her last style and a one-tap rebook link |
| Win-back 2 | 60 days after | New styles or gallery highlights |
| Win-back 3 | 90 days after | Last nudge; optional discount code (admin setting, off by default) |

Win-back rules:

- Only sent if the client ticked marketing consent. Transactional emails (confirmation, reminders) are always sent.
- Cancel all pending win-backs as soon as the client books again. The schedule restarts from the next completed visit.
- Every marketing email has a one-click unsubscribe link and `List-Unsubscribe` headers (CAN-SPAM, plus Gmail and Yahoo bulk sender rules).

### Admin notifications

| Event | Email | In-app + push |
| --- | --- | --- |
| New confirmed booking | Yes | Yes |
| Booking cancelled or rescheduled by the client | Yes | Yes |
| Balance paid online | No | Yes |
| Payment conflict / refund issued | Yes | Yes |
| Daily agenda at 7:00 AM | Yes | No |
| Webhook or email failures (3 retries failed) | Yes | Yes |

### Email build

- MJML templates compiled to HTML at build time, rendered with Nunjucks variables. Each has a plain-text version.
- Branded layout: bone background, logo, magenta button, Fraunces fallback to Georgia (email clients block web fonts).
- Every send is logged in `email_log` (template, recipient, provider id, status). Resend webhooks update delivered, bounced and complained.
- `EMAIL_PROVIDER=log` in development writes emails to `tmp/emails/*.html` instead of sending.

### Jobs run by cron (every 5 minutes)

1. `expireHolds`: set expired pending holds to `expired` and call `stripe.checkout.sessions.expire` if still open.
2. `sendDueEmails`: send jobs with `run_at <= now`, up to 50 per run, with exponential backoff on failure (max 5 tries).
3. `dailyAgenda`: once a day after 7:00 AM local.
4. `cleanup`: weekly, delete old `stripe_events`, expired sessions and orphaned uploads.

## 9. Data model

The database has 21 tables. Money is always integer cents, times are UTC `DATETIME(3)`, and ids are `BIGINT` auto-increment internally. Public URLs use a random `ref` (e.g. `MB-7K2Q9X`) or a signed token, never the id.

```text
admins            id, email UNIQUE, name, password_hash, role(owner|staff), totp_secret NULL, last_login_at, created_at
sessions          (managed by express-mysql-session)
settings          key PK, value JSON, updated_by, updated_at
                  keys: business, hours, booking(depositCents, holdMinutes, stepMinutes, bufferMinutes,
                        minNoticeHours, maxAdvanceDays), policy, emails, balanceOptions, seo
style_categories  id, name, slug UNIQUE, sort
styles            id, category_id, name, slug UNIQUE, short_desc, long_desc (markdown), duration_min DEFAULT 240,
                  price_on_consultation BOOL, from_price_cents NULL, featured BOOL, active BOOL, sort,
                  seo_title, seo_description, created_at, updated_at
style_variants    id, style_id, size(medium|semi_medium|small|NULL), length(shoulder|mid_back|waist|top_butt|
                  butt|under_butt|NULL), label, price_cents, duration_min NULL (overrides style), active, sort
                  UNIQUE(style_id, size, length)
addons            id, name, slug, description, price_cents, duration_min DEFAULT 0, applies_to_all BOOL, active, sort
addon_styles      addon_id, style_id  (when applies_to_all = false)
media             id, style_id NULL, kind(style|gallery|inspiration), path, variants JSON, width, height, alt, sort
clients           id, name, email, phone_e164, marketing_consent BOOL, consent_at, unsubscribed_at, notes,
                  created_at  INDEX(email), INDEX(phone_e164)
bookings          id, ref UNIQUE, client_id, style_id, style_variant_id, start_at, end_at, block_end_at (end + buffer),
                  status, payment_status, payment_choice(deposit|full|manual|none), source(web|admin),
                  hold_expires_at NULL, price_snapshot JSON, subtotal_cents, deposit_cents, paid_cents, balance_cents,
                  client_notes, admin_notes, inspiration_media_id NULL, manage_token_hash, policy_accepted_at,
                  stripe_checkout_session_id NULL, created_by_admin_id NULL, completed_at, cancelled_at,
                  cancel_reason, created_at, updated_at
                  INDEX(start_at), INDEX(status, start_at)
booking_addons    booking_id, addon_id, name_snapshot, price_cents, duration_min
calendar_locks    date PK  (one row per local date, used only for SELECT ... FOR UPDATE)
time_blocks       id, start_at, end_at, reason, repeat_rule NULL, created_by
payments          id, booking_id, type(deposit|full|balance|refund), provider(stripe|manual), method(card|cash|zelle|
                  cashapp|other), amount_cents, stripe_payment_intent_id NULL, stripe_refund_id NULL, note,
                  recorded_by_admin_id NULL, created_at
stripe_events     id (evt_...) PK, type, received_at, processed_at
jobs              id, type, payload JSON, run_at, status(pending|done|failed|cancelled), attempts, last_error,
                  dedupe_key UNIQUE NULL, created_at   INDEX(status, run_at)
email_log         id, booking_id NULL, client_id NULL, template, to_email, provider_id, status, created_at
notifications     id, admin_id NULL (NULL = all), type, title, body, url, read_at, created_at
push_subscriptions id, admin_id, endpoint UNIQUE, keys JSON, created_at
audit_log         id, admin_id, entity, entity_id, action, before JSON, after JSON, ip, created_at
```

Notes for Codex:

- `dedupe_key` (e.g. `reminder48:booking:123`) stops duplicate jobs. Cancelling a booking sets its pending jobs to `cancelled`.
- `manage_token_hash` stores a SHA-256 of a 32-byte random token. The raw token only goes in emails.
- Overlap check uses `start_at < :newBlockEnd AND block_end_at > :newStart`.

## 10. Seed data: styles and prices

These prices come straight from the current price flyer. `scripts/seed.js` loads them, and the owner can edit any of them in the admin. Every style defaults to 240 minutes.

One item to confirm: the flyer lists Senegalese Twist as "Medium $180, Waist Length $220, Top Butt $240". The seed reads that as size Medium at Mid Back, Waist and Top Butt lengths.

```json
{
  "settings": {
    "booking": {
      "depositCents": 3000,
      "holdMinutes": 30,
      "stepMinutes": 30,
      "bufferMinutes": 30,
      "minNoticeHours": 24,
      "maxAdvanceDays": 60,
      "defaultDurationMin": 240,
      "capacity": 3
    },
    "business": {
      "name": "Mado African Braids",
      "street": "7375 Executive Place",
      "city": "Lanham",
      "region": "MD",
      "postalCode": "20706",
      "country": "US",
      "phone": "+14437434979",
      "timezone": "America/New_York",
      "url": "https://madoafricanbraidz.com"
    }
  },
  "addons": [
    {
      "name": "Head wash",
      "slug": "head-wash",
      "priceCents": 2500,
      "durationMin": 0,
      "appliesToAll": true
    },
    {
      "name": "100% human hair upgrade",
      "slug": "human-hair-upgrade",
      "priceCents": 4000,
      "durationMin": 0,
      "appliesToAll": true
    }
  ],
  "styles": [
    {
      "name": "Knotless Braids",
      "slug": "knotless-braids",
      "category": "knotless",
      "featured": true,
      "variants": [
        [
          "medium",
          "mid_back",
          18000
        ],
        [
          "medium",
          "waist",
          20000
        ],
        [
          "semi_medium",
          "shoulder",
          22000
        ],
        [
          "semi_medium",
          "mid_back",
          24000
        ],
        [
          "semi_medium",
          "waist",
          26000
        ],
        [
          "semi_medium",
          "top_butt",
          30000
        ],
        [
          "semi_medium",
          "under_butt",
          32000
        ],
        [
          "small",
          "shoulder",
          24000
        ],
        [
          "small",
          "mid_back",
          26000
        ],
        [
          "small",
          "waist",
          30000
        ],
        [
          "small",
          "top_butt",
          32000
        ],
        [
          "small",
          "under_butt",
          34000
        ]
      ]
    },
    {
      "name": "Boho Knotless Braids",
      "slug": "boho-knotless-braids",
      "category": "boho",
      "featured": true,
      "variants": [
        [
          "medium",
          "mid_back",
          24000
        ],
        [
          "medium",
          "waist",
          26000
        ],
        [
          "medium",
          "top_butt",
          29000
        ],
        [
          "medium",
          "under_butt",
          32000
        ],
        [
          "semi_medium",
          "mid_back",
          26000
        ],
        [
          "semi_medium",
          "waist",
          28000
        ],
        [
          "semi_medium",
          "top_butt",
          30000
        ],
        [
          "semi_medium",
          "under_butt",
          34000
        ]
      ]
    },
    {
      "name": "Boho Bob",
      "slug": "boho-bob",
      "category": "boho",
      "variants": [
        [
          "medium",
          null,
          20000
        ],
        [
          "semi_medium",
          null,
          26000
        ],
        [
          "small",
          null,
          28000
        ]
      ]
    },
    {
      "name": "Senegalese Twist",
      "slug": "senegalese-twist",
      "category": "twists",
      "variants": [
        [
          "medium",
          "mid_back",
          18000
        ],
        [
          "medium",
          "waist",
          22000
        ],
        [
          "medium",
          "top_butt",
          24000
        ]
      ]
    },
    {
      "name": "Island Twist",
      "slug": "island-twist",
      "category": "twists",
      "featured": true,
      "variants": [
        [
          "medium",
          "mid_back",
          28000
        ],
        [
          "medium",
          "waist",
          30000
        ],
        [
          "medium",
          "butt",
          32000
        ],
        [
          "medium",
          "under_butt",
          34000
        ]
      ]
    },
    {
      "name": "Fulani Braids",
      "slug": "fulani-braids",
      "category": "fulani",
      "featured": true,
      "fromPriceCents": 24000,
      "priceOnConsultation": true,
      "note": "From $240 depending on style and length"
    },
    {
      "name": "Cornrows",
      "slug": "cornrows",
      "category": "other",
      "priceOnConsultation": true
    },
    {
      "name": "Passion Twist",
      "slug": "passion-twist",
      "category": "twists",
      "priceOnConsultation": true
    },
    {
      "name": "Marley Twist",
      "slug": "marley-twist",
      "category": "twists",
      "priceOnConsultation": true
    },
    {
      "name": "Invisible Locs",
      "slug": "invisible-locs",
      "category": "locs",
      "priceOnConsultation": true
    },
    {
      "name": "Soft Locs",
      "slug": "soft-locs",
      "category": "locs",
      "priceOnConsultation": true
    },
    {
      "name": "Butterfly Locs",
      "slug": "butterfly-locs",
      "category": "locs",
      "priceOnConsultation": true
    },
    {
      "name": "Crochet Braids",
      "slug": "crochet-braids",
      "category": "other",
      "priceOnConsultation": true
    },
    {
      "name": "Men’s Invisible Locs",
      "slug": "mens-invisible-locs",
      "category": "mens",
      "note": "A clean, understated loc look with neat sections and a finish tailored to you.",
      "variants": [
        [
          null,
          null,
          12000
        ]
      ]
    },
    {
      "name": "Freestyle Stitch Cornrows",
      "slug": "freestyle-stitch-cornrows",
      "category": "mens",
      "note": "Defined stitch braids with a freestyle cornrow pattern designed around your look.",
      "variants": [
        [
          null,
          null,
          8000
        ]
      ]
    }
  ]
}
```

**How consultation-priced styles book:** the client picks the style and still pays the $30 deposit to hold the slot (the "Pay in full" option is hidden). The admin sets the final price on the booking after the consultation, and the balance follows from that. Once the owner sets real prices for these, she adds variants and they book like the others.

## 11. SEO and performance

The goal is to rank in Google's local map pack for "\[style\] near me" and "\[style\] Lanham MD". That comes from three things: a separate, well-built page for every style, perfect local business data, and a fast site. Performance budget: Lighthouse 95+ on mobile for Performance, SEO, Accessibility and Best Practices.

### On-page (Codex builds)

- One page per style at `/styles/:slug`, each with a unique title and description: "Knotless Braids in Lanham, MD | From $180 | Mado African Braidz".
- One H1 per page, logical H2/H3, descriptive alt text ("Waist-length medium knotless braids with curly ends").
- Canonical URLs, lowercase slugs, no trailing-slash duplicates, 301 redirects table in admin for old URLs.
- Open Graph and Twitter card tags. Generate a branded share image per style (photo + name + "from" price) with sharp at upload time.
- `sitemap.xml` (built from the database, includes styles, gallery, area pages, with `lastmod`) and `robots.txt` (disallow `/admin`, `/book/success`, `/booking/`).
- Breadcrumbs (Home > Styles > Knotless Braids) with BreadcrumbList schema.
- FAQ section on style pages with FAQPage schema (real questions: "How long do knotless braids take?", "Do I need to bring hair?").
- Local area pages at `/areas/:town` for Bowie, Greenbelt, Largo, Hyattsville, New Carrollton, College Park, Upper Marlboro and Landover. Each needs unique content (drive time, landmarks, featured styles). No copy-paste pages; Google penalizes doorway pages.

### Structured data (JSON-LD in the layout)

```json
{
  "@context": "https://schema.org",
  "@type": "HairSalon",
  "name": "Mado African Braids",
  "url": "https://madoafricanbraidz.com",
  "telephone": "+1-443-743-4979",
  "image": "https://madoafricanbraidz.com/img/og-default.jpg",
  "logo": "https://madoafricanbraidz.com/img/logo.svg",
  "priceRange": "$180-$340",
  "address": { "@type": "PostalAddress", "streetAddress": "7375 Executive Place",
               "addressLocality": "Lanham", "addressRegion": "MD", "postalCode": "20706", "addressCountry": "US" },
  "geo": { "@type": "GeoCoordinates", "latitude": 0, "longitude": 0 },
  "openingHoursSpecification": "<built from settings.hours>",
  "sameAs": ["<instagram>", "<facebook>", "<tiktok>", "<google business profile url>"],
  "hasOfferCatalog": "<built from styles: Service + Offer with price and priceCurrency USD>"
}
```

Fill `geo` with the real coordinates. Generate all values from settings, so the admin stays the single source of truth. Validate with Google's Rich Results Test.

### Off-site (owner's checklist, not code)

1. Claim and complete the **Google Business Profile**: category "Hair salon" plus "Braiding" services, the same name, address and phone as the site, hours, booking link to `/book`, and weekly photo posts.
2. Ask every client for a Google review (the thank-you email links straight to it).
3. List the same details on Apple Business Connect, Bing Places, Yelp, StyleSeat or Booksy (profile only), and Facebook.
4. Link the site from the Instagram bio, pointing to `/book`.
5. Add the site to Google Search Console and Bing Webmaster Tools and submit the sitemap.

### Performance (Codex builds)

- Serve AVIF/WebP with `<picture>` and `srcset`, explicit width and height (no layout shift), `loading="lazy"` below the fold, `fetchpriority="high"` on the hero image.
- Inline critical CSS for above-the-fold content; one hashed CSS file under 30 KB gzipped.
- Under 20 KB of JS on public pages; admin JS loaded only under `/admin`.
- `compression` middleware, long cache headers on hashed assets, ETags on HTML.
- Cache the public styles and price data in memory for 60 s; clear it when the admin saves.
- Load the Google map only when the user clicks it (static image placeholder first).
- Analytics: Plausible or Google Analytics 4 with consent banner only if GA is used. Track funnel events: view style, start booking, reach checkout, booking confirmed.

## 12. Security, testing and deployment

The site handles money and personal data, so security and the booking tests are release blockers. Nothing goes live until the double-booking and webhook tests pass.

### Security

- `helmet` with a strict Content Security Policy (allow Stripe, the map provider and analytics only), HSTS, `SameSite=Lax` secure httpOnly cookies.
- CSRF tokens on every form (`csrf-sync`). The Stripe webhook is the only exception, and it's protected by the signature.
- Rate limits: booking hold 10/hour per IP, login 5/15 min, contact form 5/hour, availability API 120/min.
- Honeypot field + Cloudflare Turnstile on the contact form and booking step 4 (invisible mode).
- Validate every input with Zod on the server. Escape output (Nunjucks autoescape on).
- Uploads: images only (check magic bytes, not just the extension), max 8 MB, re-encoded by sharp, random filenames, stored outside the webroot.
- No card data ever touches the server (Stripe Checkout handles it).
- Daily MySQL backup via cPanel, plus a weekly `mysqldump` copied off the server.

### Tests that must exist and pass

1. Holds for the same slot fired at the same time: exactly three succeed with capacity three (run 20 parallel requests); capacity one still allows exactly one.
2. Overlap logic: back-to-back bookings with buffer, bookings across a daylight-saving change, time blocks, closed days.
3. Expired hold frees the slot. Late payment on a free slot confirms; late payment on a slot at capacity refunds and sets `payment_conflict`.
4. Webhook: bad signature returns 400; a duplicate event is ignored; deposit, full and balance each set the right payment status.
5. Pricing: server ignores tampered prices; deposit is capped at the subtotal; add-ons are summed correctly.
6. Jobs: reminders are scheduled at the right local times; cancelling a booking cancels its jobs; rebooking cancels win-backs; unsubscribed clients get no marketing email.
7. Admin permissions: staff can't open settings or issue refunds.
8. End to end (Playwright, local only): book with a Stripe test card `4242 4242 4242 4242`, see the confirmation, see it on the admin calendar.

### Environment variables (`.env.example`)

```text
NODE_ENV=production
APP_URL=https://madoafricanbraidz.com
PORT=4780
SESSION_SECRET=
DATABASE_URL=mysql://user:pass@localhost:3306/mado
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
EMAIL_PROVIDER=resend          # resend | postmark | log
RESEND_API_KEY=
EMAIL_FROM="Mado African Braidz <bookings@madoafricanbraidz.com>"
ADMIN_ALERT_EMAILS=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
UPLOAD_DIR=/home/<cpanel-user>/mado-uploads
CRON_SECRET=
```

### Deploying to shared cPanel hosting

1. Check the host first: Node.js 20 available in "Setup Node.js App", MySQL 8 or MariaDB 10.6+, SSH access, cron jobs, free SSL (AutoSSL). If any is missing, choose a different plan before building.
2. Create the MySQL database and user in cPanel.
3. Build locally or in GitHub Actions: `npm ci && npm run build` (Tailwind, MJML, asset hashing). Commit or upload `public/build`.
4. Deploy with Git (cPanel Git Version Control) or GitHub Actions over SSH/rsync to `~/mado-app`.
5. In "Setup Node.js App": Node 20, app root `~/mado-app`, startup file `src/server.js`, set all env vars, then run `npm ci --omit=dev`.
6. Run `npm run db:migrate` and `npm run db:seed` over SSH. Change the seeded admin password at first login.
7. Add the cron job: `*/5 * * * * cd ~/mado-app && /home/<user>/nodevenv/mado-app/20/bin/node scripts/run-jobs.js >> ~/logs/jobs.log 2>&1`.
8. In Stripe: add the webhook endpoint `https://madoafricanbraidz.com/webhooks/stripe` with the 5 events from Section 6. Turn on Apple Pay domain verification. Test fully in test mode, then switch to live keys.
9. In Resend: verify the domain (SPF, DKIM, DMARC records in cPanel's Zone Editor).
10. Force HTTPS and `www` to apex redirect. Submit the sitemap to Search Console.

If the shared host proves too limited (memory kills, no Node 20), the same code runs unchanged on a small VPS or Render/Railway with managed MySQL.

## 13. Milestones, acceptance criteria and Codex prompts

The build runs in 9 milestones, each a separate Codex task and pull request. Paste the prompt, review the result against its acceptance list, and merge before starting the next. Milestones 3 and 4 are the critical ones, so give them the most review.

1. **Foundation.** Prompt: "Read docs/SPEC.md. Do Milestone 1: scaffold the project per Section 3 (folder layout, Express app + server.js, zod env config, Nunjucks, Tailwind v4 build, Drizzle + MySQL connection, the full schema and migrations from Section 9, seed script with Section 10 data, pino logging, helmet/CSRF/rate-limit middleware, Vitest setup, README and .env.example)." Done when: `npm run dev` serves a page; migrate and seed run on a fresh MySQL; `npm test` passes; lint is clean.
2. **Design system and public pages.** Prompt: "Do Milestone 2: build the design tokens, fonts and components from Section 4, the /admin/design preview page, and all public pages in Section 5 (excluding the booking wizard logic), rendered from the database. Mobile first at 390 px." Done when: every page renders from seeded data; Lighthouse mobile is 95+ on Home and a style page; no banned design patterns; keyboard navigation works.
3. **Availability and holds.** Prompt: "Do Milestone 3: availabilityService, pricingService and the hold creation with calendar\_locks per Section 6, plus the availability APIs and wizard steps 1–4 up to (not including) Stripe. Include tests 1, 2 and 5 from Section 12, with shared capacity three and the 100% human hair upgrade." Done when: 20 parallel holds on one slot produce exactly three holds at capacity three; capacity-one regression also passes; DST and buffer tests pass; tampered prices are rejected.
4. **Stripe payments.** Prompt: "Do Milestone 4: Stripe Checkout for deposit and full payment, the webhook handler with idempotency, success-page polling, cancel/resume, expireHolds job, late-payment conflict refunds, and the balance Checkout flow, all per Section 6. Include tests 3 and 4." Done when: a test-card booking confirms via `stripe listen`; an abandoned checkout frees the slot after 30 minutes; replayed webhooks change nothing.
5. **Admin core.** Prompt: "Do Milestone 5: admin auth (argon2id, optional TOTP, lockout, reset), roles, audit log, dashboard, calendar (FullCalendar), bookings list and detail with all actions, and admin-created bookings, per Section 7. Include test 7." Done when: the owner can create, reschedule (drag), cancel, complete, record payment, send balance link and refund; staff are blocked from settings and refunds.
6. **Admin catalog and settings.** Prompt: "Do Milestone 6: styles and variants CRUD with photo upload and sharp resizing, add-ons, availability and time blocks, gallery, clients, settings, and the 301 redirects table, per Section 7." Done when: a new style created in admin appears on the site, in booking and in the sitemap within 60 s; price changes don't alter existing bookings.
7. **Notifications and emails.** Prompt: "Do Milestone 7: jobs table runner and cron script, all client and admin emails from Section 8 (MJML), reminders, win-back with consent and unsubscribe, admin in-app notifications with polling, Web Push and PWA manifest. Include test 6." Done when: a test booking triggers confirmation and admin alerts; reminder and win-back jobs are scheduled at the right local times; unsubscribe works; push reaches a phone.
8. **SEO, performance and polish.** Prompt: "Do Milestone 8: everything in Section 11 that Codex builds: meta tags, JSON-LD, sitemap, robots, breadcrumbs, FAQ schema, area pages scaffolding, OG images, image pipeline, caching, analytics events. Then fix any accessibility issues found by axe." Done when: Rich Results Test is valid for HairSalon, FAQ and Breadcrumb; Lighthouse 95+ on all 4 scores on mobile; zero axe violations.
9. **Launch.** Prompt: "Do Milestone 9: run the full test suite and the Playwright end-to-end test, write docs/DEPLOY.md and docs/ADMIN-GUIDE.md (plain language for the owner), and a launch checklist from Section 12." Done when: deployed on the host in Stripe test mode, owner has done 3 test bookings, then live keys are switched on.

### Launch checklist (owner + developer)

- [ ] Brand name, deposit policy and hours confirmed (Section 2)
- [ ] Logo redrawn as SVG; 20+ real photos of her work uploaded with alt text
- [ ] Policies page approved by the owner
- [ ] Stripe account verified, payouts set up, live webhook added
- [ ] Email domain verified; test emails land in the inbox, not spam
- [ ] Google Business Profile claimed, booking link set to /book
- [ ] Search Console verified, sitemap submitted
- [ ] Backups confirmed running
- [ ] First real booking taken and refunded as a final live test

## Owner amendment — Milestone 5 owner access (November 17, 2026)

Deployment instruction (November 17): deploy the current build on the main domain, using production mode and the current Stripe test keys for verification. The owner explicitly deferred Cloudflare Turnstile until later. Use `TURNSTILE_ENABLED=false` for that initial server configuration; the default stays true and genuine keys are required to enable it. Do not fabricate keys or switch the hosted app into development mode. Email delivery remains Milestone 7.

Follow-up instruction (November 17): the owner supplied the Turnstile key pair in the ignored local `.env`; enable verification on the server for booking and prepare the contact endpoint with the same protection. The contact form must stay disabled until email setup; do not create an enquiry inbox or persist messages yet. Check successful verification, hostname and the expected form action. The owner also explicitly authorized downloading a database backup to this PC's ignored `tmp/hosting/live` folder.

Build the admin core for one owner only. Staff accounts, invitations and staff management UI are deferred until requested; existing non-owner records must be denied access. The owner can edit a booking, especially its date and start time, with the same full-interval capacity of three, opening-hours, 30-minute start-step and buffer checks. Date-only changes retain the agreed price snapshot. An explicit style/extra change recomputes the affected appointment's total on the server; consultation-priced visits can receive an agreed final total. Owner-created short-notice appointments may bypass public notice/advance restrictions, but never opening hours, time blocks or capacity. Email requests from admin actions are queued for Milestone 7; password reset has its own Resend delivery path and a private ignored local-development file fallback.

## Owner amendment — public Pay page and manual transfers (November 17, 2026)

This explicitly extends Milestone 4 with `/pay` in the footer, booking/visit payment-method selection, private Zelle/Cash App proof upload, and owner review before an initial appointment is confirmed. Card payments retain Stripe Checkout and signed-webhook confirmation. Transfer recipient name and destinations come only from env (`MANUAL_PAYMENT_NAME`, `ZELLE_RECIPIENT`, `CASHAPP_CASHTAG`), so a restart after changing env updates every payment screen. Never infer payment receipt from a screenshot.

Owner correction: `/pay` has exactly one search field accepting an exact phone number, email address or booking confirmation code. Phone/email searches require no second code and may show multiple eligible payments. Results contain payment-related appointment details, not client contact details, notes or receipt files. Search is rate limited and grants session-bound, expiring payment access; it must not disclose the private booking-management token or authorize cancellation. No eligible payment returns “No pending payments found.”

Manual proofs are private re-encoded JPEG/PNG/WebP inputs, max 8 MB; metadata and review status live in `payment_proofs`. Submitting an initial proof keeps `pending_payment` and unpaid totals, extending its capacity hold for `MANUAL_REVIEW_HOURS` (working default 24, range 1–48), capped at appointment start. The owner must review promptly; expiry releases capacity. An owner approval rechecks full-interval capacity and time blocks under the date lock before recording money and confirming. A late conflict requires owner reconciliation/manual refund, never overbooking. An initial rejection cancels and frees the chair. Balance review leaves the confirmed chair intact. Duplicate submissions/decisions cannot duplicate payment, and card Checkout is blocked during proof review.

A narrow `/admin/payment-reviews` screen uses the existing seeded-owner Basic authentication with HTTPS in production, rate limiting, CSRF and audit entries. This is a payment-review bridge until Milestone 5 replaces it with the full session-authenticated admin portal. Staff cannot approve, reject or read proofs. Actual client/admin email delivery remains Milestone 7; payment confirmation jobs are recorded for that delivery layer.

### Owner amendment — multiple bookings and one combined checkout

Phone/email search must return every linked eligible pending payment; booking-code lookup returns only that booking. Each result retains individual payment. If two or more payments are ready, Pay all offers one combined Stripe card payment, with amounts recomputed and snapshotted on the server. Manual transfers already awaiting review remain listed and must not be charged again.

Combined Checkout stores a durable `payment_batches` record and batch-linked `checkout_attempts`. Payment allocation, capacity checks and all booking state changes go through bookingService, using sorted locks for all affected dates. A paid group webhook allocates the single PaymentIntent across bookings exactly once. One late/conflicting appointment is refunded only for its allocation; other paid bookings remain intact. Cancellation/expiry releases initial unpaid holds but never cancels an already confirmed appointment whose balance was being paid. Refund webhook reconciliation supports partial/full refunds and out-of-order delivery; asynchronous refund updates also subscribe to `refund.updated` and `refund.failed`. Dashboard refunds without booking metadata are allocated in booking order and flagged for owner verification. Full owner refund controls remain Milestone 5.

## Owner amendment — Milestone 7 email provider (November 18, 2026)

Use Brevo instead of Postmark for automated email delivery. Retain the cPanel mailbox for replies. Keep the existing reminder, consent, unsubscribe, email-log, owner notification and push requirements. Brevo delivery uses its email API and authenticated delivery callbacks. Verify the sending domain and test inbox delivery before enabling client sending.

## Owner amendment — additional owner accounts (November 23, 2026)

More than one `owner` account is allowed, replacing the one-owner limit of the Milestone 5 amendment. Owners are added only by the server command `npm run admin:add`; each has full access, their own password and optional two-factor. Staff sign-in, invitations and team management UI stay deferred.

## Owner amendment — payment recovery and name (November 23, 2026)

The signed webhook stays the primary confirmation. As a backup, the server may retrieve a stored Checkout session directly from Stripe with the secret key; only a complete and paid session is applied, through the same bookingService validation, locks and duplicate protection. The browser is never trusted. The public salon name is "Mado African Braids"; the domain keeps its spelling.

## Owner amendment — search and AI tools (November 23, 2026)

Tool-neutral SEO: owner-editable page titles and descriptions, verification meta tags (name and code only, never scripts), Service/Offer, BreadcrumbList and FAQPage data matching visible content, and `/llms.txt`. No third-party SEO script is loaded and no tool may change the site automatically.

## Owner amendment — guide videos (November 23, 2026)

Each admin page may have a YouTube guide video configured in code. It opens in a small floating player that never blocks the page, can be moved, enlarged, minimised or closed, and closes when the page changes. Nothing loads from YouTube before the owner asks; the public site is unaffected.

## Owner amendment — unreviewed transfers (November 23, 2026)

A submitted transfer that the owner has not reviewed by its deadline is extended once by up to 24 hours, never past the appointment and only with free capacity, under the booking date lock. Owners get reminders 6 hours and 1 hour before each deadline and an urgent alert on extension. If still unreviewed, the chair is released and the client and owner are emailed. No money is recorded without owner approval.

## Owner amendment — calendar (November 24, 2026)

Calendar colours match the portal status badges, and a submitted transfer shows as Payment to review. Cancelled and expired visits are hidden unless the owner chooses Show cancelled. Opening hours and time blocks are shaded, appointments refresh quietly every 15 seconds, and selecting one opens its details with view, review and call actions. A seven-day list is the default on phones. Blocking time from the calendar and chairs-used counts stay deferred.

## Owner amendment — appointment pages (November 24, 2026)

The appointment book opens on upcoming visits, nearest first, with Today, Upcoming, Needs review, Balance due, Past, Cancelled and All tabs, 25 per page. New and edited appointments load free times automatically with chairs left, keep a live summary in view, and can fill in an existing client. The details page offers only actions that can succeed, confirms each in its own window, refreshes when something changes (never while the owner is typing), and shows one readable history and the client's other visits. Visits match by email or phone because each booking keeps its own client record. Booking rules stay in bookingService.

## Owner amendment — styles, prices and extras (November 24, 2026)

A style's details and all of its prices save together from a size and length grid; a cleared price is switched off, never deleted. A published style must always have an active price or be priced on consultation; every path enforces this in the save transaction. Owners can publish or feature from the list, duplicate a style (the copy stays hidden), order styles (kept in the `catalog` setting; until saved, newest first), manage categories (web addresses never change on rename) and see price history from the audit log. Extras keep their internal name once created. Suggested descriptions use only facts already on the form and are never saved without the owner.

## Owner amendment — photo library and Our Work (November 24, 2026)

Library labels come from the public page itself, so they always match what clients see, and saving a photo never changes its Our Work place unless the owner asks. Photos can be hidden (kept, but on no page) or removed (restorable for 7 days, then deleted; the existing cleanup removes files). Several photos upload one after another with progress and retry; the browser shrinks, rotates and crops before sending, and the server still validates and resizes. A focus point is stored in tenths. One Our Work order (`ourWork` setting) covers photos and films; unplaced items come first. Uploaded videos can be removed and any video's cover changed. The public Our Work page adds filters and a larger view, and keeps working without JavaScript. Reference photos stay labelled after rotating or cropping.

A style page shows all of its photos in one gallery beside the details: thumbnails, arrows, swipe, keyboard and a larger view. The chosen size's photo comes first. It swipes and the thumbnails work without JavaScript.

## Owner amendment — clients (November 24, 2026)

Each booking keeps its own client record; records are grouped into one person when read, never merged or deleted. Same email, or same phone with the same name, is the same person. A shared phone with a different name and email is only a possible match, which the owner joins (reversible) or keeps apart (`clientLinks` setting). A repeat client has two or more completed or confirmed visits. Editing updates every record of the person. Salon news can be stopped but never started by the owner; one unsubscribe covers every record with that email, and come-back emails consider the whole person. Clients are not deleted: on a privacy request, personal details are removed permanently from client records, booking notes, private and payment images, logs and messages, keeping dates and amounts. It is refused while a visit, balance, payment or refund is open.

## Owner amendment — settings (November 24, 2026)

Settings are separate tabs, each saving only its own section: Business, Payments, Policies, Emails, Email wording, Opening hours, Time off, Search & AI, Security and Health check. Page redirects and the audit page stay unlinked, and two-factor is not offered. The business name is spelled "Braids" everywhere except the domain. A special day (`hours.special`) replaces the normal week for one date, in booking, on the website and in structured data. Saving hours that leave appointments outside them warns by name and needs a second confirmation; appointments never move. Time off may be all day, several days (up to 60) or weekly, and can be added or removed from the calendar. Zelle and Cash App can be switched off for new deposits (`depositOptions`); bookings made before the change keep their choices. Payment recipients are shown but only change on the server. Email wording has a sandboxed preview with sample details and a way back to the original. Owners can see who can sign in and sign out everywhere. The health check reports only what the site can check for itself.

## Owner amendment — notifications (November 24, 2026)

Alerts are worded from the live appointment when shown. Read state is kept per owner (`notification_reads`); the older `notifications.read_at` still means read by everyone. "Needs you" lists pending transfers and failed messages until handled. A failed message can be sent again only when nothing can have been delivered. Each owner chooses device alerts and quiet hours, and the studio chooses email alerts (`alerts` setting); payments to review always come through. Client names stay off device alerts unless chosen. After a successful change the web app sends owner alerts (device and email) straight away under the same MySQL lock as the jobs cron, which stays the backup; client emails and WhatsApp still go by cron. A retry never repeats an alert on a device that received it. The manifest and service worker are public because phones request them without cookies; they hold nothing private. Microsoft push is accepted. Signing out removes that device; signing out everywhere removes all of that owner's devices. Read alerts are cleared after 90 days. Each cron run records `jobs_heartbeat` for the health check.

## Owner amendment — studio policies (November 25, 2026)

The owner's rules: the deposit is kept when a client cancels or does not arrive, and the rest of a full payment is refunded. A client who is not happy with the service gets the deposit back once the braids are taken down, with no time limit. Clients call the studio at least a day before to cancel, and 48 hours before to reschedule. After something unforeseen they call to arrange another time and the deposit stays valid. Up to 15 minutes late is fine; more has a $20 late fee. Children and guests are welcome, pets are not. Clients mention allergies and recent scalp or hair treatments and bring their own hair products. Clients may see the information held about them. The hours, minutes and late fee amount are owner settings (Settings, Policies) and are wording only; nothing is charged or refunded automatically.
