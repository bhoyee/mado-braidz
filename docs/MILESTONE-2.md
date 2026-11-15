# Milestone 2 — Public site and design library

The owner requested a photo-led redesign and a different font pairing. The current design uses Manrope headings/body text, a restrained Cormorant Garamond accent, light paper backgrounds, a supplied portrait hero and a photographic style collection. This explicitly replaces the original Section 4 font choice at the owner's request. The Express/Nunjucks/MySQL stack is unchanged.

## Review locally

Start MySQL, then run `npm install`, `npm run db:seed`, `npm run build`, and `npm run dev`. Visit http://localhost:4780; use Ctrl+F5 for an existing preview. `/admin/design` prompts for the seeded owner credentials from `.env`.

## Delivered

- Public home, collection/filtering, all style details, style-based size/length prices, Our Work, About, contact/visit, legal drafts and eight local-area shells.
- Photos for all 13 catalog styles: four supplied and nine AI-generated hairstyle references. AI references are labelled on the style cards and detail pages and are not claimed as client work. Gallery extras include the supplied sew-in, spring-twist and tribal-crochet photos without changing the service catalog or prices.
- Responsive AVIF/WebP assets, self-hosted fonts, visible focus indicators, native navigation/FAQs, mobile booking action, owner-only component preview, map consent and request-only studio films.
- Seeded media metadata retains source provenance. Seed reruns preserve owner photos and captions; responsive metadata for known managed paths can be refreshed. Prices, durations and business facts remain database-backed.
- All Section 4 design components in `/admin/design`, with example interactions that never create bookings. Temporary preview protection verifies the seeded owner; full admin auth is Milestone 5.

## Assets

Built-in `image_gen` produced Boho Bob, Senegalese Twist, Fulani Braids, Cornrows, Passion Twist, Marley Twist, Invisible Locs, Soft Locs and Butterfly Locs references. Their final project files are under `public/img/styles` and listed in `src/db/style-image-manifest.json`. Exact prompts: `docs/STYLE-IMAGE-PROMPTS.json`. Original generated PNGs are retained locally under ignored `assets/style-references`; no image-generation API key is needed by the application.

The supplied Knotless, Boho, Island Twist and Crochet images are also optimized under `public/img/styles`. Three additional supplied gallery images are listed in `src/db/gallery-image-manifest.json`. Original supplied files are preserved under ignored `docs/design/imgs`. `npm run images:prepare` resizes/encodes available local originals; the prepared web files are committed, so ordinary builds work without those originals.

Studio clips and posters remain in `public/media`. All films are silent. The hero may autoplay when visible unless reduced motion or data saver is enabled. Supporting Our Work films play on request. Keyboard controls, reduced-motion/data-saver behaviour, offscreen/background pausing and manual-pause persistence are checked.

## Validation

- Build/lint pass; 66 unit/Supertest tests pass.
- Database seed and reruns pass. The catalog contains images for all 13 styles, three additional Knotless size references, and three gallery extras with source labels. No database schema changes were needed.
- Zero npm audit vulnerabilities.
- Chrome checks: 29 mobile/desktop page cases, no WCAG A/AA violations or horizontal overflow; responsive images decode; keyboard, filters, delayed map and owner-preview controls pass.
- Video checks pass for hero autoplay safeguards, request-only supporting films, keyboard controls and pause persistence.
- Final mobile Lighthouse is 98 Performance / 100 Accessibility / 100 Best Practices / 100 SEO on Home, and 99/100/100/100 on the Knotless Braids detail page. Reports and screenshots are retained locally under ignored `tmp/qa`.

## Follow-ups

Owner review of generated hairstyle accuracy; replace references with verified client/service photos when available. Add an owner portrait, genuine reviews and actual social/profile links. Approve the About introduction and legal drafts before launch. Hours are confirmed as daily 6:00 AM–6:00 PM Eastern; parking details remain to be confirmed. Use MySQL 8 or MariaDB 10.6+ for deployment; the local XAMPP database is older.

Booking availability/holds, payments, full admin functionality, email delivery, final SEO/image pipeline and production launch remain in their assigned later milestones. The contact form is a disabled preview and booking-related pages are informational only. No Milestone 3 work was started.


## Owner-requested header and price browsing

The header now combines full address, daily hours, phone, larger logo/name treatment, stronger menu typography and booking action. Hours were explicitly confirmed by the owner as Monday–Friday and Saturday–Sunday, 6:00 AM–6:00 PM. `content:sync` applies this confirmation and the supplied “Where Beauty Meets the Art of Braiding” copy to an existing local database without changing prices.

Styles own their pricing: choose a size, then see only its valid lengths and server catalog prices. Knotless has three visual choices with AI-labelled Medium, Semi-medium and Small references. Size and length browsing works with JavaScript disabled. The main style reference and starting price follow the selected size. Other styles show only their seeded size groups; consultation styles keep a personal-quote path.

`/our-work` replaces Gallery, with `/gallery` retained as a permanent redirect. `/prices` permanently redirects to `/styles`; there is no separate price page in the public navigation. The hero uses the supplied finished-look film with a poster, accessible play/pause, reduced-motion/data-saver safeguards and offscreen/background pausing.

Additional generated assets: `public/img/styles/knotless-size-medium-*`, `knotless-size-semi-medium-*` and `knotless-size-small-*`, with exact built-in tool prompts in `docs/KNOTLESS-SIZE-PROMPTS.json`. These are illustrative size guides, not client photographs or promises of an exact result.
