# Milestone 6 — Owner catalog and settings

The owner can manage the catalog and studio settings at `/admin`. Access remains owner-only; existing non-owner accounts are denied. All forms use CSRF protection, server validation and audit records.

## Owner screens

- **Styles & prices:** create a draft, add size/length price options, then publish. Edit category, descriptions, duration, consultation/from price, featured status, display order and SEO fields. Archive using the Published checkbox. Variant IDs stay intact when options are disabled, preserving booking references. Price changes apply to new bookings; existing snapshots and balances are retained.
- **Photos & Our Work:** upload JPEG, PNG, WebP or AVIF images up to 8 MB, with required descriptions. Actual image bytes and dimensions are checked, metadata is stripped, and Sharp creates WebP/AVIF files at 480/960/1600 target widths without enlarging small photos. Tag a style, choose style page or Our Work, edit captions, and reorder by drag or keyboard-accessible Move buttons followed by Save photo order. Photos are stored under `UPLOAD_DIR/catalog`, outside the release folder, and served through a constrained public-image route. Private inspiration photos and payment proofs are never exposed by that route.
- **Extras:** create/edit/archive, change price or additional duration, and allow all styles or selected styles. Both booking forms filter unavailable extras; pricing is checked again on the server.
- **Availability:** weekly hours, closed days, notice, advance-booking limit and buffer. Capacity stays three and starts stay 30 minutes, as agreed. One-off and bounded weekly blocks close all chairs. Weekly occurrences are materialized in UTC from Eastern local times, preserving wall-clock time across DST. A series can run up to one year and can be removed together. Blocks take the same calendar-day locks as holds and cannot overwrite active appointments or unexpired holds. Changing hours keeps existing appointments; move those separately if needed.
- **Clients:** search, visit history, recorded payments, last styles, marketing consent/status and private notes. The owner cannot silently opt clients into marketing. Email delivery remains Milestone 7.
- **Settings:** business/address/phone/social links, deposit, checkout hold, reschedule policy, policy text, balance payment options, future email preferences and alert addresses. The Stripe mode indicator is read-only. Stripe secrets and transfer destinations remain in the ignored environment configuration.
- **Page redirects:** local public paths only, with loop protection and automatic redirects when style slugs change. The dynamic sitemap includes newly published styles immediately and omits archived styles. Full SEO work remains Milestone 8.

Catalog/settings reads are live, so saved changes appear on new public/booking requests within the required 60 seconds. Existing bookings retain their stored names, totals, extras and durations unless the owner explicitly changes that booking through bookingService.

## Installation and deployment

No new environment variables or package dependencies are required. Existing `UPLOAD_DIR` must be persistent and writable. Apply additive migration `0006_icy_magneto.sql` before serving the new version:

```powershell
npm run db:migrate
npm run build
npm run dev
```

Development remains **http://localhost:4780**. The production workflow backs up MySQL, applies migrations, preserves `.env` and uploads, switches releases, and verifies the served commit. Routine deployments do not seed or synchronize content, so owner edits survive deployments.

## Verification

```powershell
npm run build
npm run lint
npm test
npm run test:db
npm run test:management:browser
```

Database tests create only random disposable databases and drop only their validated names. They check public publication/sitemap/redirects, price-snapshot preservation, time-block protection, variant uniqueness, audit history, balance-method enforcement and owner-only access. Browser verification creates a separate disposable database and checks real forms, photo upload/reordering, public updates, accessibility and overflow at 390/1440 px. It uses fake Stripe and never changes the real salon catalog or takes payments.

Verified locally on 18 November 2026: build/lint passed, 163 application tests passed, and 18 real database integration tests passed. Owner CRUD/photo workflows and the public booking wizard passed at 390/1440 px with zero axe violations or page overflow. Screenshots remain in ignored `tmp/qa`.

## Follow-ups

Milestone 7 adds email delivery, reminder/win-back processing, notifications and push/PWA support. Contact delivery remains disabled until that setup. Milestone 8 covers the remaining SEO/performance polish. Staff management remains deferred by the owner.
