import { describe, expect, it } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';

const config = parseEnv({
  NODE_ENV: 'test',
  APP_URL: 'https://salon.example',
  SESSION_SECRET: 'test-secret-at-least-thirty-two-characters',
  DATABASE_URL: 'mysql://test:test@localhost/mado',
  UPLOAD_DIR: 'C:/mado-uploads',
});
const makeApp = (catalog = fixtureCatalog()) => createApp({ config, catalog });
const meta = (html, key) =>
  html.match(
    new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`),
  )?.[1];

describe('search and social sharing tags', () => {
  it('gives the home page a full preview with an absolute image', async () => {
    const { text } = await request(makeApp()).get('/').expect(200);
    expect(meta(text, 'og:title')).toContain('Lanham, MD');
    expect(meta(text, 'og:description')).toContain('Knotless braids');
    expect(meta(text, 'og:url')).toBe('https://salon.example/');
    expect(meta(text, 'og:image')).toBe(
      'https://salon.example/img/share-card.jpg',
    );
    expect(meta(text, 'twitter:card')).toBe('summary_large_image');
    expect(text).toContain(
      '<link rel="canonical" href="https://salon.example/">',
    );
    const json = JSON.parse(
      text.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1],
    );
    expect(json['@type']).toBe('HairSalon');
    expect(json.openingHoursSpecification.length).toBeGreaterThan(0);
  });
  it('describes each style and ignores query strings in the canonical link', async () => {
    const { text } = await request(makeApp())
      .get('/styles/knotless-braids?utm_source=test')
      .expect(200);
    expect(meta(text, 'og:url')).toBe(
      'https://salon.example/styles/knotless-braids',
    );
    expect(meta(text, 'og:description')).toMatch(
      /^Knotless Braids from \$\d+/i,
    );
  });
  it('keeps private and unknown addresses out of sharing tags and search', async () => {
    for (const path of ['/booking/private-token', '/styles/unknown', '/nope']) {
      const { text } = await request(makeApp()).get(path);
      expect(text).not.toContain('rel="canonical"');
      expect(text).not.toContain('og:url');
      expect(text).toContain('<meta name="robots" content="noindex,nofollow">');
    }
  });
  it('escapes owner text inside structured data', async () => {
    const data = await fixtureCatalog().load();
    data.settings.business.name = '</script><script>alert(1)</script>';
    const { text } = await request(makeApp({ load: async () => data })).get(
      '/',
    );
    expect(text).not.toContain('<script>alert(1)');
  });
  it('serves robots.txt and a correctly sized share image', async () => {
    const robots = await request(makeApp()).get('/robots.txt').expect(200);
    expect(robots.text).toContain('Disallow: /admin');
    expect(robots.text).toContain('Sitemap: https://salon.example/sitemap.xml');
    const image = await request(makeApp())
      .get('/img/share-card.jpg')
      .expect(200);
    expect(image.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(image.body.length).toBeLessThan(300000);
    expect(await sharp(image.body).metadata()).toMatchObject({
      width: 1200,
      height: 630,
    });
  });
});
