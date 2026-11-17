// Explicit sandbox-only check. Creates a disposable local database, starts an
// isolated app and Stripe CLI listener, and pays on Stripe's hosted test page.
import 'dotenv/config';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { chromium } from '@playwright/test';
import { DateTime } from 'luxon';
import { parseEnv } from '../../src/config/env.js';
import { createDatabase } from '../../src/db/index.js';
import { createBookingRepository } from '../../src/services/bookingRepository.js';
import { createCatalogService } from '../../src/services/catalogService.js';
import { createApp } from '../../src/app.js';
import assert from 'node:assert/strict';

if (
  !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ||
  !process.env.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')
)
  throw new Error(
    'Add Stripe sandbox keys to ignored .env before running this test. Live keys are never accepted.',
  );
const database = 'mado_stripe_test_' + randomBytes(6).toString('hex');
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
const admin = await mysql.createConnection(source.toString());
let pool, server, listener, browser;
try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  source.pathname = '/' + database;
  const created = createDatabase(source.toString());
  pool = created.pool;
  await migrate(created.db, { migrationsFolder: 'src/db/migrations' });
  execFileSync(process.execPath, ['scripts/seed.js'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: source.toString(),
      ADMIN_EMAIL: 'stripe-test@example.test',
      ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    },
  });
  await mkdir('tmp/qa', { recursive: true });
  await mkdir('tmp/stripe-cli', { recursive: true });
  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const config = parseEnv({
    ...process.env,
    NODE_ENV: 'test',
    APP_URL: origin,
    DATABASE_URL: source.toString(),
    TURNSTILE_SITE_KEY: '',
    TURNSTILE_SECRET_KEY: '',
  });
  const ready = new Promise((resolve, reject) => {
    listener = spawn(
      'stripe',
      [
        'listen',
        '--forward-to',
        origin + '/webhooks/stripe',
        '--events',
        'checkout.session.completed,checkout.session.async_payment_succeeded,checkout.session.async_payment_failed,checkout.session.expired,charge.refunded,refund.updated,refund.failed',
        '--skip-update',
      ],
      {
        env: {
          ...process.env,
          STRIPE_API_KEY: process.env.STRIPE_SECRET_KEY,
          XDG_CONFIG_HOME: resolvePath(),
          STRIPE_NO_AUTO_UPDATE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let output = '';
    const timeout = setTimeout(
      () => reject(new Error('Stripe CLI did not connect within 45 seconds.')),
      45000,
    );
    const capture = (data) => {
      output += data.toString();
      const match = output.match(/whsec_[a-zA-Z0-9]+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    };
    listener.stdout.on('data', capture);
    listener.stderr.on('data', capture);
    listener.once('error', () => {
      clearTimeout(timeout);
      reject(new Error('Stripe CLI could not start.'));
    });
    listener.once('exit', (code) => {
      if (code) {
        clearTimeout(timeout);
        reject(new Error('Stripe CLI could not authenticate or connect.'));
      }
    });
  });
  config.STRIPE_WEBHOOK_SECRET = await ready;
  server.on(
    'request',
    createApp({
      config,
      catalog: createCatalogService(created.db),
      bookingRepository: createBookingRepository(created.db),
    }),
  );
  console.log('Stripe sandbox listener connected; local test app ready.');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const catalog = await createCatalogService(created.db).load();
  const style = catalog.styles.find((s) => s.slug === 'knotless-braids'),
    variant = style.variants[0];
  await page.goto(
    origin + `/book?style=knotless-braids&size=medium&variant=${variant.id}`,
  );
  await page.waitForFunction(() =>
    document.getElementById('summary-total').textContent.includes('180'),
  );
  await page
    .getByRole('button', { name: 'Choose extras', exact: true })
    .click();
  await page.getByRole('button', { name: 'Find a time', exact: true }).click();
  await page.locator('#booking-calendar button').first().waitFor();
  const date = DateTime.now()
    .setZone('America/New_York')
    .plus({ days: 3 })
    .toISODate();
  const day = page.getByRole('button', { name: new RegExp('^' + date) });
  if ((await day.count()) === 0)
    await page.getByRole('button', { name: 'Next month' }).click();
  await day.click();
  await page.locator('#booking-slots button:enabled').first().click();
  await page.getByRole('button', { name: 'Your details', exact: true }).click();
  await page
    .getByLabel('Full name', { exact: true })
    .fill('Stripe Sandbox Test');
  await page
    .getByLabel('Email', { exact: true })
    .fill('stripe-test@example.com');
  await page.getByLabel('Phone', { exact: true }).fill('4437434979');
  await page.getByRole('checkbox', { name: /I accept the/ }).check();
  await page
    .getByRole('button', { name: 'Continue to secure payment' })
    .click();
  try {
    await page.waitForURL('https://checkout.stripe.com/**', { timeout: 60000 });
  } catch {
    const message = await page.locator('#booking-error').textContent();
    throw new Error('Stripe checkout handoff failed: ' + message);
  }
  console.log('Hosted Stripe sandbox checkout opened.');
  async function field(selectors) {
    for (let i = 0; i < 30; i++) {
      for (const frame of page.frames())
        for (const selector of selectors) {
          const input = frame.locator(selector).first();
          if (await input.isVisible().catch(() => false)) return input;
        }
      await page.waitForTimeout(1000);
    }
    throw new Error(
      'Stripe checkout fields were not available; interactive verification may be required.',
    );
  }
  await (
    await field(['input[name="cardNumber"]', 'input[autocomplete="cc-number"]'])
  ).fill('4242424242424242');
  await (
    await field(['input[name="cardExpiry"]', 'input[autocomplete="cc-exp"]'])
  ).fill('12/30');
  await (
    await field(['input[name="cardCvc"]', 'input[autocomplete="cc-csc"]'])
  ).fill('123');
  const name = page.locator('input[name="billingName"]');
  if (await name.isVisible()) await name.fill('Stripe Sandbox Test');
  const country = page.locator('select[name="billingCountry"]');
  if (await country.isVisible()) await country.selectOption('US');
  const postal = page.locator('input[name="billingPostalCode"]');
  if (await postal.isVisible()) await postal.fill('20706');
  const submit = page.getByRole('button', { name: /^Pay(?:\s|$)/i }).last();
  await page.screenshot({
    path: 'tmp/qa/stripe-hosted-checkout.png',
    fullPage: true,
  });
  await submit.click();
  await page.waitForURL(origin + '/book/success**', { timeout: 90000 });
  await page
    .getByRole('heading', { name: 'Your chair is booked.' })
    .waitFor({ timeout: 65000 });
  await page.screenshot({ path: 'tmp/qa/stripe-real-confirmation.png' });
  const rows = await created.db.query.bookings.findMany();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'confirmed');
  assert.equal(rows[0].paidCents, 3000);
  console.log(
    'PASS: Stripe test card payment confirmed through the real CLI-forwarded webhook.',
  );
} finally {
  await browser?.close();
  listener?.kill();
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool?.end();
  if (/^mado_stripe_test_[a-f0-9]{12}$/.test(database))
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
}
function resolvePath() {
  return resolve('tmp/stripe-cli');
}
