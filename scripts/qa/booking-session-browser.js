// One tab must never send a new visit back to an earlier checkout.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
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

const repo = await memoryBookingRepository(),
  provider = fakeStripe(),
  config = parseEnv(paymentConfig),
  payments = createPaymentService(repo, provider, config);
const server = createApp({
  config,
  catalog: fixtureCatalog(),
  bookingRepository: repo,
  stripeProvider: provider,
}).listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  channel: process.env.QA_BROWSER || 'msedge',
});
try {
  const page = await (
    await browser.newContext({ viewport: { width: 390, height: 900 } })
  ).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await page.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Stripe</title>',
    }),
  );
  const start = origin + '/book?style=knotless-braids&size=medium&variant=101';
  async function details(email) {
    await page.getByLabel('Full name', { exact: true }).fill('Session Test');
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Phone', { exact: true }).fill('4437434979');
    await page.getByRole('checkbox', { name: /I accept the/ }).check();
  }
  async function pay() {
    await page
      .getByRole('button', { name: 'Continue to secure payment' })
      .click();
    await page.waitForURL(/checkout\.stripe\.com|book\/success/);
    return page.url();
  }
  async function book(email) {
    await page.goto(start);
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
    const here = page.url();
    await details(email);
    return here;
  }
  const visit = await book('first@example.test');
  const first = await pay();

  // Same visit again: reuse the open checkout, so nobody pays twice.
  await page.goto(visit);
  await details('first@example.test');
  assert.equal(await pay(), first);
  assert.equal(provider.sessions.size, 1);

  // Same tab and time, different person: a separate checkout.
  await page.goto(visit);
  await details('second@example.test');
  const second = await pay();
  assert.notEqual(second, first);
  assert.equal(provider.sessions.size, 2);

  // Stripe finished, but the webhook has not arrived.
  const session = provider.sessions.get('cs_test_2');
  session.status = 'complete';
  session.payment_status = 'paid';
  const status = origin + '/book/success?session_id=cs_test_2';
  await page.goto(status);
  assert.equal(await page.locator('#payment-actions').isVisible(), false);
  await page.clock.runFor(500);
  for (let i = 0; i < 40; i++) {
    if (await page.locator('#payment-actions').isVisible()) break;
    await page.clock.runFor(2100);
    await page.waitForTimeout(60).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  await page.locator('#payment-actions').waitFor();
  assert.match(
    await page.locator('#payment-message').innerText(),
    /don’t pay again/,
  );
  await page.getByRole('link', { name: 'Book another appointment' }).click();
  await page.waitForURL(origin + '/book*');
  await page.locator('#booking-pending').waitFor();
  assert.equal(
    await page.locator('#booking-pending-link').getAttribute('href'),
    '/book/success?session_id=cs_test_2',
  );

  // The reported loop: a new visit in this tab opens a new checkout.
  await book('third@example.test');
  const third = await pay();
  assert.match(third, /checkout\.stripe\.com/);
  assert.equal(provider.sessions.size, 3);

  // Late confirmation clears the notice.
  await payments.handleEvent(paidEvent(session));
  await page.goto(status);
  await page.locator('#payment-details').waitFor();
  await page.goto(origin + '/book');
  assert.equal(await page.locator('#booking-pending').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log('Booking session browser checks passed');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
