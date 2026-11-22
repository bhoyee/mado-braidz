import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createBookingService } from '../../src/services/bookingService.js';
import {
  memoryBookingRepository,
  validHold,
  now,
} from '../../tests/fixtures/booking.js';
import { memoryAdminRepository } from '../../tests/fixtures/admin.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
const repo = await memoryBookingRepository(),
  password = randomBytes(24).toString('hex');
const owner = {
  id: 1,
  role: 'owner',
  name: 'Owner',
  email: 'owner@example.test',
  passwordHash: await argon2.hash(password),
  authVersion: 0,
};
const admins = memoryAdminRepository(repo, owner);
const hold = await createBookingService(
  repo,
  () => now,
  paymentConfig.SESSION_SECRET,
).createHold({ ...validHold, name: 'Maya Search' }, null, {
  admin: owner,
  mode: 'override',
});
let calls = 0;
admins.searchPortal = async (query) => {
  calls++;
  const q = query.toLowerCase();
  if (q === 'old') {
    await new Promise((r) => setTimeout(r, 700));
    return [
      {
        label: 'Clients',
        items: [
          {
            title: 'Old result',
            description: 'Delayed response',
            href: '/admin/clients/1',
          },
        ],
      },
    ];
  }
  if (q === 'new')
    return [
      {
        label: 'Clients',
        items: [
          {
            title: 'New result',
            description: 'Current response',
            href: '/admin/clients/1',
          },
        ],
      },
    ];
  if (q === 'injection')
    return [
      {
        label: 'Clients',
        items: [
          {
            title: '<img src=x onerror="window.searchXss=1">',
            description: 'Literal client text',
            href: '/admin/bookings/' + hold.id,
          },
        ],
      },
    ];
  if (q === 'maya')
    return [
      {
        label: 'Appointments',
        items: [
          {
            title: 'Maya Search',
            description: 'Knotless Braids · December 3 · ' + hold.ref,
            href: '/admin/bookings/' + hold.id,
          },
        ],
      },
      {
        label: 'Clients',
        items: [
          {
            title: 'Maya Search',
            description: 'maya@example.test',
            href: '/admin/clients/1',
          },
        ],
      },
      {
        label: 'Styles & prices',
        items: [
          {
            title: 'Maya’s braid style',
            description: 'Style and prices',
            href: '/admin/styles/1',
          },
        ],
      },
    ];
  return [];
};
const server = createApp({
  config: parseEnv(paymentConfig),
  bookingRepository: repo,
  adminRepository: admins,
  catalog: fixtureCatalog(),
  stripeProvider: fakeStripe(),
}).listen(0, '127.0.0.1');
await new Promise((done) => server.once('listening', done));
const origin = 'http://127.0.0.1:' + server.address().port,
  browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
try {
  const smoke = await fetch(origin + '/admin/login', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(smoke.status, 200);
  await smoke.text();
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page
      .goto(origin + '/admin/login', {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      })
      .catch((error) => {
        console.log(JSON.stringify({ browserErrors: errors }));
        throw error;
      });
    await page.getByLabel('Email', { exact: true }).fill(owner.email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    const input = page.getByRole('combobox', {
        name: 'Search owner portal',
        exact: true,
      }),
      popup = page.locator('[data-owner-search-popup]');
    const before = calls;
    await input.fill('m');
    await page.waitForTimeout(350);
    assert.equal(calls, before);
    await input.fill('maya');
    await page.getByRole('option').first().waitFor();
    assert.equal(await page.getByRole('option').count(), 3);
    const search = await input.boundingBox(),
      bell = await page.locator('[data-notification-bell]').boundingBox();
    assert.ok(Math.abs(search.y - bell.y) < 2);
    const box = await popup.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(
      (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
    );
    await page.screenshot({
      path: `tmp/qa/owner-search-${width}.png`,
      timeout: 60000,
    });
    await input.press('ArrowDown');
    assert.ok(await input.getAttribute('aria-activedescendant'));
    await input.press('Enter');
    await page.waitForURL(origin + '/admin/bookings/' + hold.id);
    assert.equal(
      await input.count(),
      1,
      'Search remains available on the appointment page',
    );
    await input.fill('unmatchedterm');
    await page
      .getByRole('status')
      .filter({ hasText: 'No results found' })
      .waitFor();
    await input.press('Escape');
    assert.equal(await popup.isVisible(), false);
    await input.fill('old');
    await page.waitForTimeout(350);
    await input.fill('new');
    await page.getByRole('option', { name: /New result/ }).waitFor();
    await page.waitForTimeout(800);
    assert.equal(
      await page.getByRole('option', { name: /Old result/ }).count(),
      0,
    );
    await input.fill('injection');
    await page.getByRole('option', { name: /Literal client text/ }).waitFor();
    assert.equal(await page.evaluate(() => window.searchXss), undefined);
    assert.equal(await popup.locator('img').count(), 0);
    await input.fill('password');
    await page.getByRole('option', { name: /Sign-in & security/ }).waitFor();
    assert.equal(
      await page
        .getByRole('option', { name: /Sign-in & security/ })
        .getAttribute('href'),
      '/admin/settings?tab=security',
    );
    await page.locator('[data-notification-bell]').click();
    assert.equal(await popup.isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: live grouped results, bell alignment, keyboard navigation, no-match state, stale-response protection, literal text safety and accessibility.`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
