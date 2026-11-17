import { fixtureCatalog } from './fixtures/catalog.js';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { catalogRows, seedData } from '../src/db/seed-data.js';
const input = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'test-secret-that-is-at-least-32-characters',
  DATABASE_URL: 'mysql://test:test@localhost/mado',
  UPLOAD_DIR: 'C:/mado-uploads',
};
describe('foundation', () => {
  it('serves health without a database or fixed listening port', async () => {
    const response = await request(
      createApp({ config: parseEnv(input), catalog: fixtureCatalog() }),
    )
      .get('/health')
      .expect(200);
    expect(response.body).toEqual({ status: 'ok' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('renders the home page through Nunjucks', async () => {
    const response = await request(
      createApp({ config: parseEnv(input), catalog: fixtureCatalog() }),
    )
      .get('/')
      .expect(200);
    expect(response.text).toContain('<!doctype html>');
    expect(response.text).toContain('Mado African Braidz');
  });
  it('rejects unsafe form submissions', async () => {
    await request(
      createApp({ config: parseEnv(input), catalog: fixtureCatalog() }),
    )
      .post('/contact')
      .send({})
      .expect(403);
  });
  it('defaults to port 4780 and respects PORT', () => {
    expect(parseEnv(input).PORT).toBe(4780);
    expect(parseEnv({ ...input, PORT: '4781' }).PORT).toBe(4781);
  });
  it.each([
    { SESSION_SECRET: 'short' },
    { DATABASE_URL: 'https://example.com' },
    { PORT: 'invalid' },
    { PORT: '0' },
    { ADMIN_EMAIL: 'bad' },
  ])('rejects invalid env %o', (override) => {
    expect(() => parseEnv({ ...input, ...override })).toThrow();
  });
  it('requires production secrets and HTTPS', () => {
    expect(() => parseEnv({ ...input, NODE_ENV: 'production' })).toThrow();
  });
  it('permits an explicit Turnstile deferral without disabling production security', () => {
    const production = {
      ...input,
      NODE_ENV: 'production',
      APP_URL: 'https://madoafricanbraidz.com',
      STRIPE_SECRET_KEY: 'sk_test_example',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_example',
      STRIPE_WEBHOOK_SECRET: 'whsec_example',
      CRON_SECRET: 'cron-secret-for-test-only',
    };
    expect(() => parseEnv(production)).toThrow();
    expect(
      parseEnv({ ...production, TURNSTILE_ENABLED: 'false' }).TURNSTILE_ENABLED,
    ).toBe(false);
    expect(() =>
      parseEnv({
        ...production,
        TURNSTILE_ENABLED: 'false',
        APP_URL: 'http://example.test',
      }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...production, TURNSTILE_ENABLED: 'false', CRON_SECRET: '' }),
    ).toThrow();
    expect(
      parseEnv({
        ...production,
        TURNSTILE_SITE_KEY: 'site',
        TURNSTILE_SECRET_KEY: 'secret',
      }).TURNSTILE_ENABLED,
    ).toBe(true);
  });
  it('loads every flyer price and consultation style', () => {
    const rows = catalogRows();
    expect(rows).toHaveLength(13);
    expect(rows.flatMap((s) => s.variants)).toHaveLength(30);
    expect(
      rows
        .find((s) => s.slug === 'knotless-braids')
        .variants.map((v) => v.priceCents),
    ).toEqual([
      18000, 20000, 22000, 24000, 26000, 30000, 32000, 24000, 26000, 30000,
      32000, 34000,
    ]);
    expect(
      rows
        .find((s) => s.slug === 'boho-bob')
        .variants.every((v) => v.length === null),
    ).toBe(true);
    expect(rows.find((s) => s.slug === 'fulani-braids').fromPriceCents).toBe(
      24000,
    );
    expect(rows.filter((s) => s.priceOnConsultation)).toHaveLength(8);
    expect(rows.every((s) => s.durationMin === 240)).toBe(true);
    expect(
      rows
        .flatMap((s) => s.variants)
        .every((v) => Number.isInteger(v.priceCents)),
    ).toBe(true);
    expect(seedData.addons[0].priceCents).toBe(2500);
    expect(seedData.settings.booking.depositCents).toBe(3000);
  });
});

it('keeps all seed data identical to the Section 10 source', () => {
  const spec = readFileSync(
    new URL('../docs/SPEC.md', import.meta.url),
    'utf8',
  );
  const section = spec.split('## 10.')[1];
  const source = JSON.parse(section.match(/```json\s*([\s\S]*?)```/)[1]);
  expect(seedData).toEqual(source);
});
