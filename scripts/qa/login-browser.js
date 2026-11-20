import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import { memoryAdminRepository } from '../../tests/fixtures/admin.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
const repo = await memoryBookingRepository(),
  password = randomBytes(20).toString('hex'),
  admins = memoryAdminRepository(repo, {
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
        viewport: { width, height: 900 },
      }),
      page = await context.newPage();
    for (const path of ['/admin/login', '/admin/forgot', '/admin/reset']) {
      await page.goto(origin + path);
      await page.evaluate(() => document.fonts.ready);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      const violations = (await new AxeBuilder({ page }).analyze()).violations;
      assert.equal(violations.length, 0, JSON.stringify(violations));
      if (path === '/admin/login') {
        assert.equal(await page.locator('input[name="code"]').count(), 0);
        assert.equal(
          Math.round(
            await page
              .locator('.owner-entry')
              .evaluate((el) => el.getBoundingClientRect().width),
          ),
          width,
        );
        await page.screenshot({ path: 'tmp/qa/login-' + width + '.png' });
      }
    }
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page
      .getByRole('button', { name: 'Show password', exact: true })
      .click();
    assert.equal(
      await page.locator('input[name="password"]').getAttribute('type'),
      'text',
    );
    await page
      .getByRole('button', { name: 'Hide password', exact: true })
      .click();
    assert.equal(
      await page.locator('input[name="password"]').getAttribute('type'),
      'password',
    );
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    console.log(
      'PASS ' +
        width +
        'px: branded auth pages, no unused 2FA field, password visibility, successful login, no overflow, axe 0',
    );
    await context.close();
  }
} finally {
  await browser.close();
  server.closeAllConnections();
  server.close();
}
