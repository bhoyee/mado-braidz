import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { verificationTag } from '../src/services/pageSeo.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig } from './fixtures/stripe.js';

const config = parseEnv({ ...paymentConfig, APP_URL: 'https://salon.example' });
async function get(path, change = () => {}) {
  const data = await fixtureCatalog().load();
  change(data);
  return request(
    createApp({ config, catalog: { load: async () => data } }),
  ).get(path);
}
const graph = (text) =>
  JSON.parse(
    text.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1],
  )['@graph'];
const decode = (text) =>
  text
    .replaceAll('&#39;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&');

describe('structured data for search and AI tools', () => {
  it('describes a style with its real prices, breadcrumbs and visible questions', async () => {
    const { text } = await get('/styles/knotless-braids');
    const nodes = graph(text);
    const service = nodes.find((n) => n['@type'] === 'Service');
    expect(service.offers).toMatchObject({
      priceCurrency: 'USD',
      lowPrice: '180.00',
    });
    const salon = nodes.find((n) => n['@type'] === 'HairSalon');
    expect(service.provider['@id']).toBe(salon['@id']);
    expect(
      nodes
        .find((n) => n['@type'] === 'BreadcrumbList')
        .itemListElement.map((i) => i.item),
    ).toEqual([
      'https://salon.example/',
      'https://salon.example/styles',
      'https://salon.example/styles/knotless-braids',
    ]);
    const faq = nodes.find((n) => n['@type'] === 'FAQPage').mainEntity;
    expect(faq.length).toBeGreaterThan(2);
    for (const item of faq) {
      expect(decode(text)).toContain(item.name);
      expect(decode(text)).toContain(item.acceptedAnswer.text);
    }
    expect(text).toContain('| From $180 |');
    expect(text).not.toMatch(/aggregateRating|"review"/);
  });
  it('lists every public style in the home offer catalog', async () => {
    const data = await fixtureCatalog().load();
    const { text } = await get('/');
    const salon = graph(text).find((n) => n['@type'] === 'HairSalon');
    expect(salon.hasOfferCatalog.itemListElement).toHaveLength(
      data.styles.length,
    );
    expect(salon.priceRange).toMatch(/^\$\d+-\$\d+$/);
  });
  it('publishes a guide that matches the site', async () => {
    const { text, headers } = await get('/llms.txt');
    expect(headers['content-type']).toContain('text/plain');
    for (const value of [
      '7375 Executive Place, Lanham, MD 20706',
      'https://salon.example/styles/knotless-braids): from $180',
      'Deposit: $30',
      'Sunday: 10:00 AM to 6:00 PM',
    ])
      expect(text).toContain(value);
    expect(text).not.toMatch(/admin|client/i);
  });
});

describe('owner search settings', () => {
  it('uses saved wording safely and falls back when empty', async () => {
    const { text } = await get('/styles', (data) => {
      data.settings.search = {
        pages: { '/styles': { title: 'Braids <b>& more', description: '' } },
      };
    });
    expect(text).toContain('<title>Braids &lt;b&gt;&amp; more</title>');
    expect(text).toContain('Compare knotless braids');
  });
  it('shows verification tags on the home page only', async () => {
    const add = (data) => {
      data.settings.search = {
        verification: [{ name: 'google-site-verification', content: 'abc123' }],
      };
    };
    const tag = '<meta name="google-site-verification" content="abc123">';
    expect((await get('/', add)).text).toContain(tag);
    expect((await get('/styles', add)).text).not.toContain(tag);
  });
  it('accepts codes and full tags from any tool', () => {
    expect(verificationTag('', 'google-site-verification')).toBeNull();
    expect(verificationTag('abc_123-X', 'google-site-verification')).toEqual({
      name: 'google-site-verification',
      content: 'abc_123-X',
    });
    expect(
      verificationTag('<meta name="some-tool.verify" content="A1b2C3" />'),
    ).toEqual({ name: 'some-tool.verify', content: 'A1b2C3' });
  });
  it.each([
    '<script src="https://x.example/a.js"></script>',
    '<meta name="robots" content="noindex">',
    '<meta name="viewport" content="width1">',
    '<meta http-equiv="refresh" content="0;url=https://x.example">',
    '<meta name="tool" content="abc"><script>alert(1)</script>',
    'just-a-code',
  ])('rejects %s', (value) => {
    expect(() => verificationTag(value)).toThrow();
  });
});
