import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import { DateTime } from 'luxon';
import { createDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
import { createBookingRepository } from '../../src/services/bookingRepository.js';
import { createBookingService } from '../../src/services/bookingService.js';
import { validHold } from '../../tests/fixtures/booking.js';

const name = 'mado_browser_test_' + randomBytes(6).toString('hex');
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
const admin = await mysql.createConnection(source.toString());
let pool, server, browser, app;
try {
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  source.pathname = '/' + name;
  const database = createDatabase(source.toString());
  pool = database.pool;
  await migrate(database.db, { migrationsFolder: 'src/db/migrations' });
  const password = randomBytes(24).toString('hex');
  const settings = {
    ...paymentConfig,
    DATABASE_URL: source.toString(),
    ADMIN_EMAIL: 'owner@example.test',
    ADMIN_PASSWORD: password,
    UPLOAD_DIR: 'tmp/management-browser-uploads',
  };
  const seed = spawnSync(process.execPath, ['scripts/seed.js'], {
    env: { ...process.env, ...settings },
    encoding: 'utf8',
  });
  if (seed.status !== 0)
    throw new Error('Disposable database seed failed: ' + seed.stderr);
  app = createApp({ config: parseEnv(settings), stripeProvider: fakeStripe() });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const repo = createBookingRepository(database.db);
  const start = DateTime.now()
    .setZone('America/New_York')
    .plus({ days: 5 })
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
  const data = await repo.catalog();
  await createBookingService(
    repo,
    undefined,
    settings.SESSION_SECRET,
  ).createHold({
    ...validHold,
    styleId: data.styles[0].id,
    styleVariantId: data.styles[0].variants[0].id,
    startAt: start,
    email: 'qa-client@example.test',
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  await mkdir('tmp/qa', { recursive: true });
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    async function save(button) {
      await Promise.all([
        page.waitForEvent(
          'framenavigated',
          (frame) => frame === page.mainFrame(),
        ),
        button.click(),
      ]);
      await page.waitForLoadState('networkidle');
    }
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    for (const path of [
      'styles',
      'styles/new',
      'addons',
      'availability',
      'gallery',
      'clients',
      'settings',
      'redirects',
    ]) {
      await page.goto(origin + '/admin/' + path);
      assert.equal(await page.locator('h1').count(), 1, path);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        path + ' overflow at ' + width,
      );
      const axe = await new AxeBuilder({ page }).analyze();
      assert.deepEqual(
        axe.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        path + ' accessibility at ' + width,
      );
      await page.screenshot({
        path: `tmp/qa/manage-${path.replaceAll('/', '-')}-${width}.png`,
        fullPage: true,
      });
      console.log(`Screen ${path} passed at ${width}px`);
    }
    await page.goto(origin + '/admin/styles/new');
    await page
      .getByLabel('Style name', { exact: true })
      .fill('Studio braids ' + width);
    await page
      .getByLabel('Page address', { exact: false })
      .fill('studio-braids-' + width);
    await save(page.getByRole('button', { name: 'Save style', exact: true }));
    await page.waitForURL(/\/admin\/styles\/\d+$/);
    const editURL = page.url();
    const option = page.locator('form[action$="/variants"]').last();
    await option.getByLabel('Braid size').selectOption('medium');
    await option.getByLabel('Length').selectOption('mid_back');
    await option.getByLabel('Price (USD)', { exact: true }).fill('195.50');
    await save(option.getByRole('button', { name: 'Save price option' }));
    await page.waitForLoadState('networkidle');
    await page.getByLabel('Published on the website').check();
    await save(page.getByRole('button', { name: 'Save style', exact: true }));
    await page.waitForLoadState('networkidle');
    assert.equal(
      (await fetch(origin + '/styles/studio-braids-' + width)).status,
      200,
    );
    const photo = page.locator('form[action="/admin/gallery/upload"]');
    const image = await sharp({
      create: { width: 700, height: 900, channels: 3, background: '#73489a' },
    })
      .jpeg()
      .toBuffer();
    await photo.getByLabel('Photo', { exact: true }).setInputFiles({
      name: 'studio-test.jpg',
      mimeType: 'image/jpeg',
      buffer: image,
    });
    await photo
      .getByLabel('Describe the photo for visitors')
      .fill('A finished studio braid style for QA');
    await save(photo.getByRole('button', { name: 'Upload photo' }));
    await page.waitForURL(editURL);
    await page.waitForLoadState('networkidle');
    const publicPage = await fetch(origin + '/styles/studio-braids-' + width);
    assert.ok((await publicPage.text()).includes('/media/catalog/'));
    await page.goto(origin + '/admin/gallery');
    await page.locator('[data-photo-move="1"]').first().click();
    await save(
      page.getByRole('button', { name: 'Save photo order', exact: true }),
    );
    await page.waitForLoadState('networkidle');
    await page.goto(origin + '/admin/addons');
    const extra = page.locator('form[action="/admin/addons"]').last();
    await extra.getByLabel('Name', { exact: true }).fill('Beads ' + width);
    await extra
      .getByLabel('Internal name', { exact: false })
      .fill('beads-' + width);
    await extra.getByLabel('Price (USD)').fill('15');
    await save(extra.getByRole('button', { name: 'Save extra' }));
    await page.waitForLoadState('networkidle');
    assert.ok(
      (await repo.catalog()).addons.some((a) => a.slug === 'beads-' + width),
    );
    await page.goto(origin + '/admin/availability');
    await page.getByLabel('Minimum advance notice (hours)').fill('12');
    await save(
      page.getByRole('button', { name: 'Save availability', exact: true }),
    );
    await page.waitForLoadState('networkidle');
    assert.equal((await repo.catalog()).settings.booking.minNoticeHours, 12);
    await page.goto(origin + '/admin/settings');
    await page
      .getByLabel('Business name', { exact: true })
      .fill('Mado Test Studio');
    await page.getByLabel('Booking deposit (USD)').fill('35');
    await page
      .getByLabel('Additional policy text')
      .fill('Please arrive ten minutes before your appointment.');
    await save(page.getByRole('button', { name: 'Save settings' }));
    await page.waitForLoadState('networkidle');
    assert.equal((await repo.catalog()).settings.booking.depositCents, 3500);
    assert.ok(
      (await (await fetch(origin + '/policies')).text()).includes(
        'Please arrive ten minutes',
      ),
    );
    await page.goto(origin + '/admin/clients');
    await page
      .getByRole('link', { name: /View Test Client/ })
      .first()
      .click();
    await page
      .getByLabel('Preferences and notes for the studio')
      .fill('Prefers a quiet appointment.');
    await save(page.getByRole('button', { name: 'Save notes' }));
    await page.waitForLoadState('networkidle');
    assert.equal(
      await page
        .getByLabel('Preferences and notes for the studio')
        .inputValue(),
      'Prefers a quiet appointment.',
    );
    await page.goto(origin + '/admin/redirects');
    await page
      .getByLabel('Old path', { exact: false })
      .fill('/old-studio-' + width);
    await page
      .getByLabel('New path', { exact: false })
      .fill('/styles/studio-braids-' + width);
    await save(page.getByRole('button', { name: 'Save redirect' }));
    await page.waitForLoadState('networkidle');
    assert.equal(
      (await fetch(origin + '/old-studio-' + width, { redirect: 'manual' }))
        .status,
      301,
    );
    assert.deepEqual(errors, []);
    console.log(
      `Owner management CRUD, photo upload/reorder, public updates and axe passed at ${width}px`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise((done) => server.close(done));
  await app?.locals.closeDatabase();
  await pool?.end();
  if (/^mado_browser_test_[a-f0-9]{12}$/.test(name))
    await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}
