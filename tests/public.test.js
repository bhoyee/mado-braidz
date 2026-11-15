import { catalogRows } from '../src/db/seed-data.js';
import { beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { decorateCatalog, safePhoto } from '../src/routes/public/index.js';
const config = parseEnv({
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-at-least-thirty-two-characters',
  DATABASE_URL: 'mysql://test:test@localhost/mado',
  UPLOAD_DIR: 'C:/mado-uploads',
});
const makeApp = (catalog = fixtureCatalog()) => createApp({ config, catalog });
describe('Milestone 2 public pages', () => {
  it('gives all 13 styles a photo and discloses the 9 generated references', async () => {
    const data = decorateCatalog(await fixtureCatalog().load());
    expect(data.styles.every((style) => Boolean(style.photo))).toBe(true);
    expect(data.styles.filter((style) => style.photo.generated)).toHaveLength(
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
      for (const size of style.photo.variants.sizes) {
        await request(makeApp()).get(size.path).expect(200);
        if (size.avif) await request(makeApp()).get(size.avif).expect(200);
      }
  });

  it('renders the photographic hero and a deferred studio film', async () => {
    const response = await request(makeApp()).get('/').expect(200);
    expect(response.text).toContain('poster="/media/at-the-chair.webp"');
    expect(response.text).toContain('data-src="/media/at-the-chair.mp4"');
    expect(response.text).toContain('preload="none"');
    expect(response.text).not.toContain(' autoplay');
    expect(response.text).not.toContain('Real studio photographs coming soon');
  });
  it('serves seekable video with same-origin media policy', async () => {
    const response = await request(makeApp())
      .get('/media/finished-look.mp4')
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
    expect(updated.text).toContain('The art of beautiful braids.');
  });

  it('keeps public pages useful when the active catalog is empty', async () => {
    const data = await fixtureCatalog().load();
    data.styles = [];
    for (const path of ['/', '/styles', '/prices']) {
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
    '/prices',
    '/styles/knotless-braids',
    '/styles/boho-bob',
    '/styles/fulani-braids',
    '/gallery',
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
    await request(makeApp()).get('/styles?category[x]=1').expect(400);
  });
  it('shows every flyer price and represents null lengths and consultation honestly', async () => {
    const response = await request(makeApp()).get('/prices').expect(200);
    expect(response.text).toContain('$340');
    expect(response.text).toContain('Standard');
    expect(response.text).toContain('Price on consultation');
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
