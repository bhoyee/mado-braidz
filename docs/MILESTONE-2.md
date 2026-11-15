# Milestone 2 — Public site and design library

The owner requested a photo-led redesign and a different font pairing. The current design uses Manrope headings/body text, a restrained Cormorant Garamond accent, light paper backgrounds, a supplied portrait hero and a photographic style collection. This explicitly replaces the original Section 4 font choice at the owner's request. The Express/Nunjucks/MySQL stack is unchanged.

## Review locally

Start MySQL, then run `npm install`, `npm run db:seed`, `npm run build`, and `npm run dev`. Visit http://localhost:4780; use Ctrl+F5 for an existing preview. `/admin/design` prompts for the seeded owner credentials from `.env`.

## Delivered

- Public home, collection/filtering, all style details, full price menu, photo/film gallery, About, contact/visit, legal drafts and eight local-area shells.
- Photos for all 13 catalog styles: four supplied and nine AI-generated hairstyle references. AI references are labelled on the style cards and detail pages and are not claimed as client work. Gallery extras include the supplied sew-in, spring-twist and tribal-crochet photos without changing the service catalog or prices.
- Responsive AVIF/WebP assets, self-hosted fonts, visible focus indicators, native navigation/FAQs, mobile booking action, owner-only component preview, map consent and request-only studio films.
- Seeded media metadata retains source provenance. Seed reruns preserve owner photos and captions; responsive metadata for known managed paths can be refreshed. Prices, durations and business facts remain database-backed.
- All Section 4 design components in `/admin/design`, with example interactions that never create bookings. Temporary preview protection verifies the seeded owner; full admin auth is Milestone 5.

## Assets

Built-in `image_gen` produced Boho Bob, Senegalese Twist, Fulani Braids, Cornrows, Passion Twist, Marley Twist, Invisible Locs, Soft Locs and Butterfly Locs references. Their final project files are under `public/img/styles` and listed in `src/db/style-image-manifest.json`. Exact prompts: `docs/STYLE-IMAGE-PROMPTS.json`. Original generated PNGs are retained locally under ignored `assets/style-references`; no image-generation API key is needed by the application.

The supplied Knotless, Boho, Island Twist and Crochet images are also optimized under `public/img/styles`. Three additional supplied gallery images are listed in `src/db/gallery-image-manifest.json`. Original supplied files are preserved under ignored `docs/design/imgs`. `npm run images:prepare` resizes/encodes available local originals; the prepared web files are committed, so ordinary builds work without those originals.

Studio clips and posters remain in `public/media`. All films are silent and play only when requested in the current layout. The gallery never autoplays. Keyboard controls, reduced-motion/data-saver behaviour, offscreen/background pausing and manual-pause persistence are checked.

## Validation

- Build/lint pass; 65 unit/Supertest tests pass.
- Database seed and reruns pass. The catalog contains all 13 media associations and source labels, plus three gallery extras. No database schema changes were needed.
- Zero npm audit vulnerabilities.
- Chrome checks: 25 mobile/desktop page cases, no WCAG A/AA violations or horizontal overflow; responsive images decode; keyboard, filters, delayed map and owner-preview controls pass.
- All three studio films pass request-only playback and keyboard/pause tests.
- Final mobile Lighthouse is 100 Performance / 100 Accessibility / 100 Best Practices / 100 SEO on Home and the Knotless Braids detail page. Reports and screenshots are retained locally under ignored `tmp/qa`.

## Follow-ups

Owner review of generated hairstyle accuracy; replace references with verified client/service photos when available. Add an owner portrait, genuine reviews and actual social/profile links. Approve the About introduction and legal drafts before launch. Confirm hours and parking details. Use MySQL 8 or MariaDB 10.6+ for deployment; the local XAMPP database is older.

Booking availability/holds, payments, full admin functionality, email delivery, final SEO/image pipeline and production launch remain in their assigned later milestones. The contact form is a disabled preview and booking-related pages are informational only. No Milestone 3 work was started.
