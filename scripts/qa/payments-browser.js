import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createPaymentService } from '../../src/services/paymentService.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import {
  fakeStripe,
  paidEvent,
  paymentConfig,
} from '../../tests/fixtures/stripe.js';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const repo = await memoryBookingRepository(),
  provider = fakeStripe();
const config = parseEnv(paymentConfig);
const payments = createPaymentService(repo, provider, config);
const server = createApp({
  config,
  catalog: fixtureCatalog(),
  bookingRepository: repo,
  stripeProvider: provider,
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', async (response) => {
      if (response.url().includes('/api/') && response.status() >= 400) {
        const data = await response.json().catch(() => ({}));
        console.log(
          JSON.stringify({
            path: new URL(response.url()).pathname,
            status: response.status(),
            error: data.error,
            message: data.message,
          }),
        );
      }
    });
    await page.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Mock Stripe sandbox</title><h1>Secure checkout handoff</h1>',
      }),
    );
    await page.goto(
      origin + '/book?style=knotless-braids&size=medium&variant=101',
    );
    await page.waitForFunction(
      () => document.getElementById('summary-total').textContent === '$180',
    );
    await page
      .getByRole('button', { name: 'Choose extras', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Find a time', exact: true })
      .click();
    await page.locator('#booking-calendar button:enabled').first().click();
    await page.locator('#booking-slots button:enabled').first().click();
    await page
      .getByRole('button', { name: 'Your details', exact: true })
      .click();
    await page
      .getByLabel('Full name', { exact: true })
      .fill('Payment Browser Test');
    await page
      .getByLabel('Email', { exact: true })
      .fill('payment@example.test');
    await page.getByLabel('Phone', { exact: true }).fill('4437434979');
    await page.getByRole('checkbox', { name: /I accept the/ }).check();
    await page
      .getByRole('button', { name: 'Continue to secure payment' })
      .click();
    await page.waitForURL('https://checkout.stripe.com/**');
    const cancelled = repo.rows.at(-1);
    await page.goto(origin + '/book?resume=' + cancelled.ref);
    await page.waitForFunction(
      () => !document.querySelector('[data-booking-step="4"]').hidden,
    );
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(
      await page.getByLabel('Full name', { exact: true }).inputValue(),
      'Payment Browser Test',
    );
    await page.getByRole('checkbox', { name: /I accept the/ }).check();
    await page
      .getByRole('button', { name: 'Continue to secure payment' })
      .click();
    await page.waitForURL('https://checkout.stripe.com/**');
    const session = [...provider.sessions.values()].at(-1);
    await payments.handleEvent(paidEvent(session, 'evt_browser_' + width));
    await page.goto(origin + '/book/success?session_id=' + session.id);
    await page
      .getByRole('heading', { name: 'Your chair is booked.' })
      .waitFor();
    assert.match(
      await page.locator('#payment-totals').innerText(),
      /30\.00.*150\.00/,
    );
    const report = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    assert.deepEqual(report.violations, []);
    await page.screenshot({
      path: `tmp/qa/payment-confirmation-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole('link', { name: 'View your visit', exact: true })
      .click();
    await page.getByRole('button', { name: /Pay.*balance securely/ }).click();
    await page.waitForURL('https://checkout.stripe.com/**');
    const balance = [...provider.sessions.values()].at(-1);
    assert.equal(balance.amount_total, 15000);
    await payments.handleEvent(
      paidEvent(balance, 'evt_browser_balance_' + width),
    );
    await page.goto(origin + '/book/success?session_id=' + balance.id);
    await page
      .getByRole('heading', { name: 'Your chair is booked.' })
      .waitFor();
    assert.match(
      await page.locator('#payment-totals').innerText(),
      /180\.00.*0\.00/,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    'PASS: mobile/desktop secure handoff, cancel/resume, paid confirmation, calendar link, private balance checkout and accessibility (mock Stripe provider).',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
