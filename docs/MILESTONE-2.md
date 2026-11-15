# Milestone 2 — Design system and public pages

Implemented locally for the Express/Nunjucks/MySQL application. No Sites hosting, production deployment, or booking engine was added.

## Review

Start MySQL, then run:

```powershell
npm install
npm run db:seed
npm run build
npm run dev
```

Open http://localhost:4780. The owner design library is http://localhost:4780/admin/design; the browser prompts for the seeded owner credentials from `.env`.

## Scope delivered

- Responsive bone/ink editorial layouts based on `docs/design/landing.png`, the supplied PNG logo, a vector braid motif, self-hosted Fraunces/Figtree, visible copper focus indicators, and a mobile booking action.
- Database-backed home, style collection/filtering, every seeded style detail, full price menu, gallery, About, contact/visit, policy/privacy/terms drafts, and eight area page shells. Prices, durations, business details and public settings come from MySQL. Owner-supplied studio films and extracted stills now give Home, About and Gallery real imagery. Style listings without individual photos are type-led rather than placeholder panels; no fake reviews are published.
- Owner-only `/admin/design` with buttons, style/menu components, length chips, add-on control, example date grid/time pills, booking summary, fields/errors, badges, dismissible feedback, empty state, native modal and sample data table. Preview selections have no booking side effects.
- Native menu/FAQ controls and server-rendered category filtering work without JS. A small same-origin JS file enhances the map, modal and design previews. Maps load only after a click. Motion respects reduced-motion preferences.
- Safe Markdown for database descriptions, escaped text, safe public image paths, strict CSP, CSRF validation, and a temporary HTTPS-only-in-production owner Basic-auth guard for the design library. The full admin login remains Milestone 5.

## Validation

- `npm run build`, `npm run lint`, `npm test`: pass; 63 unit/Supertest tests.
- `npm run db:migrate`, `npm run db:seed`: pass on the existing local XAMPP database. No schema changes were needed.
- `npm audit`: zero vulnerabilities.
- `npm run test:browser`: Chrome at 390px and 1440px, 25 page/viewport checks, WCAG A/AA automated analysis, no horizontal overflow, keyboard skip link/mobile navigation, category filters, delayed map loading, owner access, length selector, modal/Escape and summary controls.
- Lighthouse 13.6 mobile audits on Home and Knotless Braids: 99 Performance, 100 Accessibility, 100 Best Practices, 100 SEO on both redesigned pages. Reports/screenshots are local in ignored `tmp/qa`. These results include the real studio media and optimized logo.
- Public CSS is approximately 9.3 KB gzip; public JS approximately 1.5 KB gzip. The supplied logo artwork is preserved in a roughly 12 KB WebP web copy. A vector master remains a follow-up.

## Assumptions and follow-ups

- Public brand remains “Mado African Braidz”. The supplied logo says “Mado Braids”; its artwork is preserved while the accessible business name follows the spec.
- The About introduction describes the one-stylist studio and its services; no experience dates, credentials, training history or client claims are invented. Owner review is still needed.
- Hours are expressed as Tuesday–Saturday by appointment, Sunday–Monday closed, without guessing closing times or parking instructions. Owner confirmation remains needed.
- Real client photos, an owner portrait, actual social/profile links and genuine reviews are still needed. The gallery handles empty data honestly and renders approved media rows when provided.
- Policies, privacy and terms are clearly marked drafts. Owner approval and updates describing actual payment/email behavior are needed before launch.
- `/book` and payment-result/manage-booking paths are informational holding pages. Slot availability, booking state changes and payment processing remain Milestones 3–4. No client appointment data is exposed at placeholder token URLs.
- The contact form is a disabled preview, with call-to-contact available. Email delivery and Turnstile-backed form handling remain follow-up work; no message is silently accepted or discarded as a success.
- The area routes are presentation shells. Full local SEO, structured data, sitemaps, canonical redirects, caching, image processing, analytics and launch polishing remain Milestone 8.
- Local XAMPP MariaDB 10.4 is older than the required MariaDB 10.6+/MySQL 8 deployment target. Repeat database checks on a supported database before deployment.


## Public redesign with supplied video

The owner requested a more mature salon direction. The revised pages use a dark editorial hero, stronger type, quieter rectangular actions, real studio imagery, a type-led style collection, a concise price preview and a film journal. The repetitive empty panels and decorative ring placements have been removed from public pages. The original design library and database-backed catalog remain in place.

Source footage was inspected from all three local files in `docs/design/videos`. The finished-look film supplies the hero, and the other clips show the braiding process and detail. Three silent 10–12 second MP4s and WebP stills are prepared by `npm run media:prepare`; only the prepared web assets are committed. Audio is removed, pixel format is broadly compatible, and MP4 metadata is moved to the front for streaming.

Video controls have visible names, keyboard activation and state feedback. Reduced motion and data saver disable automatic downloads/playback. The gallery never auto-downloads films. Offscreen or background films pause, and a visitor's explicit pause is preserved. No-JavaScript users can view posters or open the MP4 links.

Redesign checks: build/lint pass, 63 unit/Supertest tests pass, zero dependency audit findings, and the dedicated `npm run test:video` browser checks pass for all three clips. Tests also verify same-origin media CSP and HTTP byte ranges. The 25-case desktop/mobile WCAG checks pass with no violations or horizontal overflow. Mobile Lighthouse is 99/100/100/100 on Home and the Knotless Braids detail page.

Remaining content: individual photos for each service, an owner portrait, real social/profile links and genuine reviews. No supplied frame is claimed to depict an unrelated service, and no client testimonial or history is invented. The biography and legal drafts still need owner review. Booking, payments and admin implementation remain in their assigned later milestones.

The repeated browser checks exposed a preview access issue: successful owner-preview requests were consuming the sign-in quota. The design preview now counts only failed credential attempts; empty browser challenges and successful owner access do not consume the five-attempt allowance. A regression test verifies both normal refreshes and failed-attempt lockout.
