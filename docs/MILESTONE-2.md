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

`/our-work` replaces Gallery, with `/gallery` retained as a permanent redirect. `/prices` permanently redirects to `/styles`; there is no separate price page in the public navigation. The hero uses the supplied studio film with a poster, accessible play/pause, reduced-motion/data-saver safeguards and offscreen/background pausing.

Additional generated assets: `public/img/styles/knotless-size-medium-*`, `knotless-size-semi-medium-*` and `knotless-size-small-*`, with exact built-in tool prompts in `docs/KNOTLESS-SIZE-PROMPTS.json`. These are illustrative size guides, not client photographs or promises of an exact result.


## Purple redesign (owner request)

The owner asked for purple and for type that suits a modern braid salon. The public site was redesigned on the same routes and data:

- Palette is now purple-led (night, plum, violet, lilac on cream/linen; gold for prices on dark). SPEC Section 4 is updated with the tokens.
- Type returns to Fraunces (soft axis) for display and Figtree for body/UI, at 17–18 px body size. Manrope and Cormorant were removed.
- Home: dark plum hero with the real studio film, category band, signature styles in arch cards, a printed-style price menu, four booking steps beside a before/after film, the studio (tour + chair films), a real-work strip, visit, FAQ.
- Films (`npm run media:prepare`, sources in ignored `docs/design/videos`): `studio-knotless` (hero: video5 43–54 s only, the knotless client smiling in front of the studio sign, kept at full height and framed near the top so the sign shows above her; the owner chose this single clip over two-clip and four-clip montages. Renamed from `finished-look` so browsers cannot replay a stale cached clip. Note: video5 never shows the full sign; the top is outside the original frame throughout), `transformation` (video3, spring twist before/after), `studio-tour` (video4, first 14 s only), `at-the-chair` (video2, cropped to the cape), `braid-detail` (video1, not used on the home page). video1 was otherwise skipped because it was filmed in a living room.
- Single stylesheet `src/styles/app.css`; `home.css` and `salon.css` were removed. `consultStyles` was added to the public template data.
- Validation: 66 tests pass, lint clean, browser QA 29/29 page cases with no WCAG A/AA violations or horizontal overflow.

### Hero revision

The hero no longer uses decorative devices (circular text stamp, offset arch outline, italic tagline, statistics row), which made it feel template- or AI-generated, and it no longer repeats the hours, style list or second Book button. It is now one heading, one line, one action, beside the hero film shown full height and uncropped, labelled "Real client · filmed in our Lanham studio".

Video choice: video5 is the only clip that shows the finished result, a happy client and the real studio sign together. video3 (spring twists, before/after) opens in a living room and stays in "How it works"; video4 is an empty room with storage clutter; video1 and video2 were filmed in a living room. The hero now uses video5 43–54 s, when the client faces the camera.

The default home heading/intro changed; the old default "The art of beautiful braids." is auto-upgraded at render, like earlier defaults.

### Style cards

Style cards (home, Styles, area pages) now place the name, category and "from" price on the photo over a dark fade; the whole card is one link. At the owner's request the cards no longer show the duration, size chips or the "AI style reference" badge, and the home page no longer carries the AI-image note. The AI disclosure remains on each style detail page beneath the main photo. Home section labels are no longer numbered.

### Price menu

The home price menu now shows the full list (every size, length and price, plus Fulani "from" and the consultation styles), rendered from the catalog and matching the owner's current flyer, instead of repeating the cards' "from" prices. Three columns on desktop, two on tablets, a swipeable row on phones. Length labels now read "Shoulder length" and "Waist length" to match the flyer.
The price menu was then reworked to stay short: deposit/head-wash/hair notes sit beside the heading, a row of style tabs shows one style at a time, and each style's prices appear as a length × size grid (built from the catalog as `style.matrix`). Without JavaScript every grid is shown in turn.

### Studio section

The home studio section now shows one silent, autoplaying film of the real room (`studio-space`: video4 12–16.5 s and 22–26.5 s joined with a fade, skipping the storage carts and the moments where the person filming is reflected in a mirror) in a tall arch, beside the owner's statement, story, a 2×2 values grid and "Meet Mado" / "Plan your visit". The film comes first on phones. `scripts/prepare-media.js` now has a reusable `buildMontage()` used for the hero and this film.

### Home page trimmed, footer

The home page no longer has the Our Work strip or the Visit section (both remain on their own pages; the footer gained a "Get directions" link). The footer now shows accepted payment methods (Visa, Mastercard, American Express, Discover, Cash App, Zelle, cash) as inline badges and "Powered by GiddyHost" (linking to giddyhost.com). Social icons (Instagram, TikTok, Facebook, Google reviews) render from `settings.business.social` — https links only, each shown only when set; Instagram and TikTok are set; Facebook uses a search link until the exact page address is confirmed. Defaults live in `src/db/public-defaults.js` (`publicSettings.social`); a `business.social` setting overrides them.
At the owner's request the studio section went back to the two original films (`studio-tour` and `at-the-chair`) with play buttons instead of autoplay, keeping the new text layout; films come first on phones. The `studio-space` clip is still generated but no longer used on the page.

The "Your next appointment / Make room for a new look" closing band was removed from the shared layout (every page): the sticky header's "Book your chair", the mobile Book/Call bar, the hero and each price panel already cover booking. The FAQ now sits on a full-width soft blush band (`--color-blush` #F9E3ED, the logo pink softened; all text passes AA on it). The About page values use the same 2×2 `values-grid` as the home studio section.

### Styles page catalog

`/styles` now lists every bookable option instead of summary cards: each style is one block (photo, category, name, Details link) with its sizes and lengths as price tiles, each linking to `/book?style=&size=&length=&variant=` (the same format the style detail page uses). Category filters work as before. Consultation styles show their "from" price or "Price on consultation" with Book-a-consultation and Call tiles. The home page signature cards are unchanged and still link to style details.
`/styles` also has a live search box (`?q=`). Typing filters instantly in the browser: a style shows when every word matches its name/category, otherwise only the size/length tiles that match ("waist" → just waist-length options). The address updates as you type, Escape clears it, and without JavaScript the form submits and the server hides non-matching styles (all styles in the category are still sent, so clearing the search restores them).

### Length guide

Style pages with lengths now have a "Not sure which length? See the length guide" panel just above "Choose your size". It opens in place and only then loads the owner's guide image (`public/img/guides`, prepared by `npm run images:guides` from `docs/design/Braids-Length-Guide.png`). The caption explains that top butt and under butt sit just above and below the guide's butt-length mark. Not shown for size-only (Boho Bob) or consultation styles.
