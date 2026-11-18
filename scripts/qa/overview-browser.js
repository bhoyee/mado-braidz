import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import argon2 from 'argon2';
import { DateTime } from 'luxon';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createBookingService } from '../../src/services/bookingService.js';
import {
  memoryBookingRepository,
  validHold,
} from '../../tests/fixtures/booking.js';
import { memoryAdminRepository } from '../../tests/fixtures/admin.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
const repo = await memoryBookingRepository();
await createBookingService(repo).createHold(validHold);
const base = { ...repo.rows[0] },
  today = DateTime.now().setZone('America/New_York').startOf('day');
repo.rows.splice(0);
for (let n = 8; n >= 1; n--) {
  repo.rows.push({
    ...base,
    id: n,
    ref: 'UPCOMING-' + n,
    status: 'confirmed',
    startAt: today.plus({ days: n, hours: 10 }).toJSDate(),
    paidCents: 3000,
    balanceCents: 15000,
    subtotalCents: 18000,
  });
  repo.rows.push({
    ...base,
    id: 100 + n,
    ref: 'HOLD-' + n,
    status: 'pending_payment',
    startAt: today.plus({ days: n, hours: 10 }).toJSDate(),
    holdExpiresAt: new Date(Date.now() + 3600000),
  });
}
repo.paymentRows.push({
  id: 1,
  bookingId: 1,
  type: 'deposit',
  method: 'card',
  amountCents: 3000,
  createdAt: new Date(Date.now() - 1000),
});
const password = randomBytes(24).toString('hex');
const admins = memoryAdminRepository(repo, {
  id: 1,
  role: 'owner',
  name: 'Owner',
  email: 'owner@example.test',
  passwordHash: await argon2.hash(password),
  authVersion: 0,
});
const app = createApp({
  config: parseEnv(paymentConfig),
  bookingRepository: repo,
  adminRepository: admins,
  catalog: fixtureCatalog(),
  stripeProvider: fakeStripe(),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    assert.equal(await page.locator('.overview-metric').count(), 4);
    assert.equal(await page.locator('.overview-panel').count(), 1);
    assert.equal(await page.locator('.overview-panel tbody tr').count(), 16);
    assert.equal(
      await page
        .locator('.overview-panel tbody tr')
        .first()
        .locator('a')
        .getAttribute('href'),
      '/admin/bookings/1',
    );
    assert.equal(
      await page
        .locator('.overview-panel .owner-table-wrap')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      true,
    );
    assert.equal(
      await page
        .locator('.overview-panel')
        .getByRole('columnheader', { name: 'Payment source' })
        .count(),
      1,
    );
    for (const path of [
      '/admin',
      '/admin/payments?period=week',
      '/admin/payments?period=month',
      '/admin/balances',
    ]) {
      await page.goto(origin + path);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        path + ' overflow',
      );
      const violations = (await new AxeBuilder({ page }).analyze()).violations;
      assert.equal(violations.length, 0, JSON.stringify(violations));
      await page.screenshot({
        path:
          'tmp/qa/overview-' +
          width +
          '-' +
          (path === '/admin'
            ? 'home'
            : path.includes('balances')
              ? 'balances'
              : path.endsWith('week')
                ? 'week'
                : 'month') +
          '.png',
      });
    }
    await page.goto(origin + '/admin');
    await page
      .locator('.overview-metric[href="/admin/payments?period=week"]')
      .click();
    await page.waitForURL(origin + '/admin/payments?period=week');
    await page
      .getByRole('heading', { name: 'Received this week.', exact: true })
      .waitFor();
    console.log(
      'PASS ' +
        width +
        'px: overview cards, all confirmed/pending appointments and scrollable table, receipt and balance tables, no overflow, axe 0',
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
