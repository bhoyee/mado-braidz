import { catalogRows } from '../src/db/seed-data.js';
import { beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { decorateCatalog, safePhoto } from '../src/routes/public/index.js';
it('uses featured styles for the home signature section, including styles after the first six', async () => {
  const data = await fixtureCatalog().load();
  data.styles.forEach((style) => {
    style.featured = false;
  });
  const selected = data.styles.at(-1);
  selected.featured = true;
  const app = createApp({ config, catalog: { load: async () => data } });
  const page = await request(app).get('/').expect(200);
  const section = page.text.match(
    /<section[^>]*aria-labelledby="styles-heading"[\s\S]*?<\/section>/,
  )[0];
  expect(section).toContain('/styles/' + selected.slug);
  expect(section).not.toContain('/styles/' + data.styles[0].slug + '"');
});
const config = parseEnv({
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-at-least-thirty-two-characters',
  DATABASE_URL: 'mysql://test:test@localhost/mado',
  UPLOAD_DIR: 'C:/mado-uploads',
});
const makeApp = (catalog = fixtureCatalog()) => createApp({ config, catalog });
describe('Milestone 2 public pages', () => {
  it('shows both fixed-price men’s services on home, in the category and in booking', async () => {
    const app = makeApp();
    const home = await request(app).get('/').expect(200);
    expect(home.text).toContain('id="mens-heading"');
    const mensSection = home.text.match(
      /<section[^>]*mens-section[\s\S]*?<\/section>/,
    )[0];
    expect(mensSection).not.toContain('deposit');
    expect(mensSection).not.toContain('hours');
    for (const [slug, price] of [
      ['mens-invisible-locs', '$120'],
      ['freestyle-stitch-cornrows', '$80'],
    ]) {
      expect(home.text).toContain(`/book?style=${slug}`);
      expect(mensSection).toContain(`/img/styles/${slug}-960.webp`);
      expect(home.text).not.toContain(`id="panel-${slug}"`);
      expect(home.text).not.toContain(`id="tab-${slug}"`);
      const detail = await request(app).get(`/styles/${slug}`).expect(200);
      expect(detail.text).toContain(price);
      expect(detail.text).toContain('4 hours reserved');
      expect(detail.text).not.toContain('Choose your <em>size.');
    }
    const category = await request(app)
      .get('/styles?category=mens')
      .expect(200);
    expect(category.text).toContain('Men’s Braids &amp; Locs');
    expect(category.text).toContain('$120');
    expect(category.text).toContain('$80');
    expect(category.text).not.toContain('id="knotless-braids"');
  });
  it('gives all 13 styles a photo and discloses the 9 generated references', async () => {
    const data = decorateCatalog(await fixtureCatalog().load());
    expect(
      data.styles
        .filter((style) => style.category !== 'mens')
        .every((style) => Boolean(style.photo)),
    ).toBe(true);
    expect(data.styles.filter((style) => style.photo?.generated)).toHaveLength(
      9,
    );
    const generated = await request(makeApp())
      .get('/styles/boho-bob')
      .expect(200);
    expect(generated.text).toContain('AI-generated style reference');
    const supplied = await request(makeApp())
      .get('/styles/knotless-braids')
      .expect(200);
    expect(supplied.text).not.toContain('AI-generated style reference');
  });
  it('serves both responsive sizes for each style reference', async () => {
    const data = decorateCatalog(await fixtureCatalog().load());
    for (const style of data.styles)
      for (const size of style.photo?.variants.sizes || []) {
        await request(makeApp()).get(size.path).expect(200);
        if (size.avif) await request(makeApp()).get(size.avif).expect(200);
      }
  });

  it('renders the video hero and a deferred studio film', async () => {
    const response = await request(makeApp()).get('/').expect(200);
    // Media URLs carry a version stamp so browsers never replay a stale clip.
    expect(response.text).toMatch(
      /poster="\/media\/studio-knotless\.webp\?v=[a-z0-9]+"/,
    );
    expect(response.text).toMatch(
      /data-src="\/media\/studio-knotless\.mp4\?v=[a-z0-9]+"/,
    );
    expect(response.text).toContain('preload="none"');
    expect(response.text).not.toContain(' autoplay');
    expect(response.text).not.toContain('Real studio photographs coming soon');
  });
  it('serves seekable video with same-origin media policy', async () => {
    const response = await request(makeApp())
      .get('/media/studio-knotless.mp4')
      .set('Range', 'bytes=0-63')
      .expect(206);
    expect(response.headers['content-type']).toContain('video/mp4');
    expect(response.headers['content-range']).toContain('bytes 0-63/');
    expect(response.headers['content-security-policy']).toContain(
      "media-src 'self'",
    );
  });
  it('keeps owner-written home copy while upgrading the old default', async () => {
    const data = await fixtureCatalog().load();
    data.settings.seo.pages.home.heading = 'My own studio heading';
    const response = await request(
      makeApp(fixtureCatalog({ load: async () => data })),
    )
      .get('/')
      .expect(200);
    expect(response.text).toContain('My own studio heading');
    data.settings.seo.pages.home.heading = 'Braids done slowly,';
    const updated = await request(
      makeApp(fixtureCatalog({ load: async () => data })),
    )
      .get('/')
      .expect(200);
    expect(updated.text).toContain('Where beauty meets the art of braiding.');
  });

  it('keeps public pages useful when the active catalog is empty', async () => {
    const data = await fixtureCatalog().load();
    data.styles = [];
    for (const path of ['/', '/styles']) {
      const response = await request(
        makeApp(fixtureCatalog({ load: async () => data })),
      )
        .get(path)
        .expect(200);
      expect(response.text).not.toContain('NaN');
    }
  });

  it.each(catalogRows().map((style) => [style.slug, style.name]))(
    'renders the seeded style %s',
    async (slug, name) => {
      const response = await request(makeApp())
        .get(`/styles/${slug}`)
        .expect(200);
      expect(response.text).toContain(name);
    },
  );

  it.each([
    '/',
    '/styles',
    '/styles/knotless-braids',
    '/styles/boho-bob',
    '/styles/fulani-braids',
    '/our-work',
    '/about',
    '/contact',
    '/policies',
    '/privacy',
    '/terms',
    '/book',
    '/book/success',
    '/areas/bowie',
    '/areas/greenbelt',
    '/areas/largo',
    '/areas/hyattsville',
    '/areas/new-carrollton',
    '/areas/college-park',
    '/areas/upper-marlboro',
    '/areas/landover',
  ])('renders %s with shared navigation and one heading', async (path) => {
    const response = await request(makeApp()).get(path).expect(200);
    expect(response.text.match(/<h1[ >]/g)).toHaveLength(1);
    expect(response.text).toContain('Skip to content');
    expect(response.text).toContain('/book');
    expect(response.headers['content-security-policy']).not.toContain(
      'unsafe-inline',
    );
  });
  it('filters styles on the server and validates query values', async () => {
    const response = await request(makeApp())
      .get('/styles?category=knotless')
      .expect(200);
    expect(response.text).toContain('Knotless Braids');
    expect(response.text).not.toContain('Boho Bob');
    await request(makeApp()).get('/styles?category=unknown').expect(400);
    // Search hides non-matching styles (still sent, so live search can restore them).
    const searched = await request(makeApp())
      .get('/styles?q=boho%20bob')
      .expect(200);
    expect(searched.text).toMatch(/id="boho-bob"[^>]*data-search="[^"]*"\s*>/);
    expect(searched.text).toMatch(/id="knotless-braids"[^>]*\shidden>/);
    expect(searched.text).toContain('1 style to explore');
    const none = await request(makeApp()).get('/styles?q=zzzz').expect(200);
    expect(none.text).toContain('0 styles to explore');
    expect(none.text).toContain('No styles match that search.');
    // A malformed query is ignored rather than failing the page.
    await request(makeApp()).get('/styles?q[x]=1').expect(200);
    await request(makeApp()).get('/styles?category[x]=1').expect(400);
  });
  it('keeps prices within each style and redirects legacy URLs', async () => {
    await request(makeApp())
      .get('/prices')
      .expect(301)
      .expect('Location', '/styles');
    await request(makeApp())
      .get('/gallery')
      .expect(301)
      .expect('Location', '/our-work');
    const response = await request(makeApp())
      .get('/styles/knotless-braids?size=small')
      .expect(200);
    expect(response.text).toContain('$340');
    expect(response.text).toContain('Under butt');
    const consultation = await request(makeApp())
      .get('/styles/fulani-braids')
      .expect(200);
    expect(consultation.text).toContain('Price on consultation.');
  });
  it('shows the confirmed hours, address, phone and Our Work navigation', async () => {
    const response = await request(makeApp()).get('/').expect(200);
    expect(response.text).toContain('6:00 AM–9:00 PM');
    expect(response.text).toContain('Mon\u2013Sat');
    expect(response.text).toContain('7375 Executive Place');
    expect(response.text).toContain('(443) 743-4979');
    expect(response.text).toContain('Styles &amp; Prices');
    expect(response.text).toContain('Our Work');
    expect(response.text).not.toContain('href="/prices"');
  });
  it('opens only the selected size lengths using server catalog prices', async () => {
    const response = await request(makeApp())
      .get('/styles/knotless-braids?size=medium&price=1')
      .expect(200);
    const lengths = response.text
      .split('id="lengths"')[1]
      .split('</section>')[0];
    expect(lengths).toContain('Mid back');
    expect(lengths).toContain('$180');
    expect(lengths).toContain('$200');
    expect(lengths).not.toContain('Shoulder');
    expect(lengths).not.toContain('$1<');
    expect(response.text).toContain('knotless-size-medium');
    expect(response.text).toContain('knotless-size-semi-medium');
    expect(response.text).toContain('knotless-size-small');
    await request(makeApp())
      .get('/styles/knotless-braids?size=unknown')
      .expect(400);
    await request(makeApp())
      .get('/styles/knotless-braids?size[x]=small')
      .expect(400);
  });
  it('renders 404s for unknown styles, areas and unimplemented private booking tokens', async () => {
    for (const url of [
      '/styles/unknown',
      '/areas/unknown',
      '/areas/__proto__',
      '/areas/constructor',
      '/missing',
      '/booking/not-a-real-token',
    ])
      await request(makeApp()).get(url).expect(404);
  });
  it('renders actual catalog changes and escapes database text', async () => {
    const catalog = fixtureCatalog();
    const data = await catalog.load();
    data.settings.business.name = '<script>alert(1)</script>';
    data.styles[0].name = 'Fresh DB style';
    data.styles[0].variants[0].priceCents = 12345;
    const response = await request(
      makeApp(fixtureCatalog({ load: async () => data })),
    )
      .get('/styles/knotless-braids')
      .expect(200);
    expect(response.text).toContain('Fresh DB style');
    expect(response.text).toContain('$123.45');
    expect(response.text).not.toContain('<script>alert(1)</script>');
  });
  it('sanitizes markdown and rejects external/private media paths', async () => {
    const data = await fixtureCatalog().load();
    data.styles[0].longDesc =
      '<script>alert(1)</script>\n\n**Care** [bad](javascript:alert(1))';
    const style = decorateCatalog(data).styles[0];
    expect(style.longHtml).not.toContain('<script>');
    expect(style.longHtml).not.toContain('href=');
    expect(style.longHtml).toContain('<strong>Care</strong>');
    expect(
      safePhoto({ path: '/uploads/private.jpg', alt: 'Private' }),
    ).toBeNull();
    expect(
      safePhoto({ path: 'https://example.com/a.jpg', alt: 'External' }),
    ).toBeNull();
    expect(safePhoto({ path: '/img/work.jpg', alt: 'Braids' })).not.toBeNull();
  });
  it('does not load Google Maps before an explicit click', async () => {
    const response = await request(makeApp()).get('/contact');
    expect(response.text).not.toContain('<iframe');
    expect(response.text).toContain('data-load-map');
    expect(response.text).toContain('data-map="https://www.google.com/maps?q=');
    expect(response.headers['content-security-policy']).toContain(
      'https://www.google.com',
    );
    expect(response.text).toContain('/img/studio/office-entrance-960.webp');
  });
  it('reports unsent messages rather than claiming success', async () => {
    const agent = request.agent(makeApp());
    const page = await agent.get('/contact');
    const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const response = await agent
      .post('/contact')
      .type('form')
      .send({ _csrf: token, name: 'Example' })
      .expect(503);
    expect(response.text).toContain('not being sent yet');
  });
  it('returns an unavailable response when database access fails', async () => {
    await request(
      makeApp(
        fixtureCatalog({
          load: async () => {
            throw new Error('db unavailable');
          },
        }),
      ),
    )
      .get('/')
      .expect(503);
  });
});
describe('owner-only design preview', () => {
  it('limits failed credentials without counting successful previews or empty challenges', async () => {
    const app = makeApp(
      fixtureCatalog({
        findAdmin: async () => ({ role: 'owner', passwordHash }),
      }),
    );
    for (let i = 0; i < 6; i++) {
      await request(app).get('/admin/design').expect(401);
      await request(app)
        .get('/admin/design')
        .auth('owner@example.com', 'owner-test-password')
        .expect(200);
    }
    for (let i = 0; i < 5; i++)
      await request(app)
        .get('/admin/design')
        .auth('owner@example.com', 'incorrect')
        .expect(401);
    await request(app)
      .get('/admin/design')
      .auth('owner@example.com', 'incorrect')
      .expect(429);
  });

  let passwordHash;
  beforeAll(async () => {
    passwordHash = await argon2.hash('owner-test-password', {
      type: argon2.argon2id,
    });
  });
  it('blocks anonymous access before loading the catalog', async () => {
    await request(makeApp()).get('/admin/design').expect(401);
  });
  it('accepts the seeded owner password and keeps examples private', async () => {
    const catalog = fixtureCatalog({
      findAdmin: async (email) =>
        email === 'owner@example.com' ? { role: 'owner', passwordHash } : null,
    });
    const response = await request(makeApp(catalog))
      .get('/admin/design')
      .auth('owner@example.com', 'owner-test-password')
      .expect(200);
    expect(response.text).toContain('The studio,');
    expect(response.text).toContain('demo-dialog');
    expect(response.headers['cache-control']).toBe('no-store');
    await request(makeApp(catalog))
      .get('/admin/design')
      .auth('owner@example.com', 'incorrect')
      .expect(401);
  });
  it('rejects staff credentials', async () => {
    const catalog = fixtureCatalog({
      findAdmin: async () => ({ role: 'staff', passwordHash }),
    });
    await request(makeApp(catalog))
      .get('/admin/design')
      .auth('staff@example.com', 'owner-test-password')
      .expect(401);
  });
});

it('publishes both opening schedules and included hair across the public pages', async () => {
  for (const path of [
    '/',
    '/styles',
    '/styles/knotless-braids',
    '/policies',
    '/terms',
  ]) {
    const response = await request(makeApp()).get(path).expect(200);
    expect(response.text).toContain('6:00 AM\u20139:00 PM');
    expect(response.text).toContain('10:00 AM\u20136:00 PM');
    expect(response.text).toContain('50% human hair');
    expect(response.text).not.toMatch(/bring your (own )?braiding hair/i);
  }
  const style = await request(makeApp())
    .get('/styles/knotless-braids')
    .expect(200);
  expect(style.text).toContain('100% human hair');
  expect(style.text).toContain('$40');
});

it('loads the approved shared capacity, start interval and hair upgrade without changing base prices', async () => {
  const data = await fixtureCatalog().load();
  expect(data.settings.booking).toMatchObject({
    capacity: 3,
    stepMinutes: 30,
    bufferMinutes: 30,
  });
  expect(data.settings.hours.weekly.monday).toEqual({
    open: '06:00',
    close: '21:00',
    closed: false,
  });
  expect(data.settings.hours.weekly.saturday).toEqual({
    open: '06:00',
    close: '21:00',
    closed: false,
  });
  expect(data.settings.hours.weekly.sunday).toEqual({
    open: '10:00',
    close: '18:00',
    closed: false,
  });
  expect(data.settings.policy.hairIncluded).toBe(true);
  expect(
    data.addons.find((addon) => addon.slug === 'human-hair-upgrade'),
  ).toMatchObject({ priceCents: 4000, durationMin: 0, appliesToAll: true });
  expect(
    data.addons.find((addon) => addon.slug === 'head-wash').priceCents,
  ).toBe(2500);
});
