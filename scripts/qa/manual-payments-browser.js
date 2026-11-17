import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import argon2 from 'argon2';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import { fakeStripe, paymentConfig } from '../../tests/fixtures/stripe.js';
const uploadDir = await mkdtemp(join(tmpdir(), 'mado-manual-browser-'));
const repo = await memoryBookingRepository();
const password = randomBytes(24).toString('hex');
const owner = {
  id: 1,
  role: 'owner',
  email: 'owner@example.test',
  passwordHash: await argon2.hash(password),
};
const app = createApp({
  config: parseEnv({
    ...paymentConfig,
    UPLOAD_DIR: uploadDir,
    ZELLE_RECIPIENT: '4437434979',
    CASHAPP_CASHTAG: '$magdalinearrey',
  }),
  catalog: fixtureCatalog({
    findAdmin: async (email) => (email === owner.email ? owner : null),
  }),
  bookingRepository: repo,
  stripeProvider: fakeStripe(),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
const receipt = await sharp({
  create: { width: 500, height: 300, channels: 3, background: '#eee' },
})
  .png()
  .toBuffer();
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
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
      .fill('Manual Payment Test');
    await page.getByLabel('Email', { exact: true }).fill('manual@example.test');
    await page.getByLabel('Phone', { exact: true }).fill('4437434979');
    await page.getByRole('radio', { name: /Zelle/ }).check();
    await page.locator('#booking-payment-proof').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: receipt,
    });
    await page.getByRole('checkbox', { name: /I accept the/ }).check();
    await page
      .getByRole('button', { name: 'Submit payment for review', exact: true })
      .click();
    await page.waitForURL('**/booking/**');
    await page.getByText('Payment awaiting review', { exact: true }).waitFor();
    const row = repo.rows.at(-1),
      proof = repo.proofRows.at(-1);
    assert.equal(row.paidCents, 0);
    assert.equal(row.status, 'pending_payment');
    await page.screenshot({
      path: `tmp/qa/manual-pending-${width}.png`,
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
    const adminContext = await browser.newContext({
        httpCredentials: { username: owner.email, password },
      }),
      adminPage = await adminContext.newPage();
    await adminPage.goto(origin + '/admin/payment-reviews');
    await adminPage
      .locator(`form[action="/admin/payment-reviews/${proof.id}"]`)
      .getByRole('button', { name: 'Approve verified receipt' })
      .click();
    await adminPage.waitForURL('**/admin/payment-reviews');
    await page.reload();
    assert.equal(row.status, 'confirmed');
    assert.equal(row.paidCents, 3000);
    await page.goto(origin + '/pay');
    await page
      .getByLabel('Phone, email or booking confirmation code', { exact: true })
      .fill('4437434979');
    await page
      .getByRole('button', { name: 'Find my payment', exact: true })
      .click();
    await page.getByRole('link', { name: 'Pay now', exact: true }).click();
    await page.waitForURL('**/booking/**');
    await page.getByRole('radio', { name: /Cash App/ }).check();
    await page.locator('#manual-proof').setInputFiles({
      name: 'balance.png',
      mimeType: 'image/png',
      buffer: receipt,
    });
    await page
      .getByRole('button', { name: 'Submit payment for review', exact: true })
      .click();
    await page.getByText('Payment awaiting review', { exact: true }).waitFor();
    assert.equal(row.paidCents, 3000);
    const balanceProof = repo.proofRows.at(-1);
    await adminPage.reload();
    await adminPage
      .locator(`form[action="/admin/payment-reviews/${balanceProof.id}"]`)
      .getByRole('button', { name: 'Approve verified receipt' })
      .click();
    await adminPage.waitForURL('**/admin/payment-reviews');
    await page.reload();
    assert.equal(row.paidCents, 18000);
    assert.equal(row.balanceCents, 0);
    await page.goto(origin + '/pay');
    await page
      .getByLabel('Phone, email or booking confirmation code', { exact: true })
      .fill(row.ref);
    await page
      .getByRole('button', { name: 'Find my payment', exact: true })
      .click();
    await page
      .getByText('No pending payments found.', { exact: true })
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
      path: `tmp/qa/pay-page-${width}.png`,
      fullPage: true,
    });
    await adminContext.close();
    await context.close();
  }
  console.log(
    'PASS: mobile/desktop Zelle booking, private proof upload, owner approval, Cash App balance, paid-in-full lookup and accessibility.',
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  await rm(uploadDir, { recursive: true, force: true });
}
