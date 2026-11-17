import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { mkdir } from 'node:fs/promises';
import { createApp } from '../../src/app.js';
import { createBookingService } from '../../src/services/bookingService.js';
import { createPaymentService } from '../../src/services/paymentService.js';
import { parseEnv } from '../../src/config/env.js';
import {
  memoryBookingRepository,
  validHold,
} from '../../tests/fixtures/booking.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import {
  fakeStripe,
  paidEvent,
  paymentConfig,
} from '../../tests/fixtures/stripe.js';
const repo = await memoryBookingRepository(),
  provider = fakeStripe(),
  config = parseEnv(paymentConfig);
const bookings = createBookingService(repo, undefined, config.SESSION_SECRET),
  payments = createPaymentService(repo, provider, config);
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
    await page.route('https://checkout.stripe.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<h1>Mock combined Stripe checkout</h1>',
      }),
    );
    const start = DateTime.now()
      .setZone('America/New_York')
      .plus({ days: width === 390 ? 3 : 4 })
      .startOf('day')
      .set({ hour: 10 })
      .toUTC()
      .toISO();
    const email = `batch-${width}@example.test`;
    const holds = [
      await bookings.createHold({ ...validHold, email, startAt: start }),
      await bookings.createHold({ ...validHold, email, startAt: start }),
    ];
    async function search(query) {
      await page.goto(origin + '/pay');
      await page
        .getByLabel('Phone, email or booking confirmation code', {
          exact: true,
        })
        .fill(query);
      await page
        .getByRole('button', { name: 'Find my payment', exact: true })
        .click();
    }
    await search(holds[0].ref);
    assert.equal(await page.locator('.pay-found').count(), 1);
    assert.equal(await page.locator('[data-pay-all]').count(), 0);
    await search(email);
    assert.equal(await page.locator('.pay-found').count(), 2);
    assert.equal(
      await page.getByRole('link', { name: 'Pay now', exact: true }).count(),
      2,
    );
    await page
      .getByRole('button', { name: 'Pay all $60 by card', exact: true })
      .waitFor();
    assert.deepEqual(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
      [],
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `tmp/qa/pay-all-options-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Pay all $60 by card', exact: true })
      .click();
    await page.waitForURL('https://checkout.stripe.com/**');
    let session = [...provider.sessions.values()].at(-1);
    assert.equal(session.amount_total, 6000);
    await payments.handleEvent(
      paidEvent(session, 'evt_batch_browser_' + width),
    );
    await page.goto(origin + '/pay/success?session_id=' + session.id);
    await page
      .getByRole('heading', {
        name: 'Your payments are confirmed.',
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator('.batch-entry').count(), 2);
    await page.screenshot({
      path: `tmp/qa/pay-all-confirmation-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(
      (
        await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations,
      [],
    );
    await search(validHold.phone);
    await page
      .getByRole('button', { name: 'Pay all $300 by card', exact: true })
      .click();
    await page.waitForURL('https://checkout.stripe.com/**');
    session = [...provider.sessions.values()].at(-1);
    await page.goto(
      origin + '/pay/batch/' + session.metadata.batchId + '?cancel=1',
    );
    await page.waitForURL(origin + '/pay');
    assert.equal(
      repo.rows.find((r) => r.id === holds[0].id).status,
      'confirmed',
    );
    assert.equal(repo.rows.find((r) => r.id === holds[0].id).paidCents, 3000);
    await search(email);
    await page
      .getByRole('button', { name: 'Pay all $300 by card', exact: true })
      .click();
    await page.waitForURL('https://checkout.stripe.com/**');
    session = [...provider.sessions.values()].at(-1);
    assert.equal(session.amount_total, 30000);
    await payments.handleEvent(
      paidEvent(session, 'evt_batch_browser_balance_' + width),
    );
    await page.goto(origin + '/pay/success?session_id=' + session.id);
    await page
      .getByRole('heading', {
        name: 'Your payments are confirmed.',
        exact: true,
      })
      .waitFor();
    assert.equal(repo.rows.find((r) => r.id === holds[0].id).balanceCents, 0);
    assert.equal(repo.rows.find((r) => r.id === holds[1].id).balanceCents, 0);
    await search(email);
    await page
      .getByText('No pending payments found.', { exact: true })
      .waitFor();
    await context.close();
  }
  console.log(
    'PASS: mobile/desktop reference-only lookup, all contact matches, individual/combined options, combined deposits/balances, cancellation and accessibility (mock Stripe).',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
