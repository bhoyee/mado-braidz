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
    let nativeDialogs = 0;
    page.on('dialog', async (dialog) => {
      nativeDialogs++;
      await dialog.dismiss();
    });
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
    assert.equal(await page.locator('input[name="slug"]').count(), 0);
    // Published without a price is refused before anything is sent.
    await page.getByRole('button', { name: 'Create style' }).click();
    await page.locator('.owner-alert').waitFor({ state: 'visible' });
    assert.match(page.url(), /styles\/new$/);
    await page.locator('[data-size="medium"]').check();
    await page.locator('[data-length="mid_back"]').check();
    await page
      .getByLabel('Medium, Mid back price', { exact: true })
      .fill('195.50');
    await page.getByRole('button', { name: 'Suggest text' }).click();
    assert.match(
      await page.getByLabel('Full description').inputValue(),
      /Sizes: medium/,
    );
    await save(page.getByRole('button', { name: 'Create style' }));
    await page.waitForURL(/\/admin\/styles\/\d+$/);
    const editURL = page.url();
    // Several prices, one save; a bulk change can be undone.
    await page.locator('[data-section="prices"]').click();
    await page.locator('[data-size="small"]').check();
    await page.getByLabel('Small, Mid back price', { exact: true }).fill('240');
    await page.locator('[data-bulk-amount]').fill('10');
    await page.locator('[data-bulk-apply]').click();
    assert.equal(
      await page
        .getByLabel('Small, Mid back price', { exact: true })
        .inputValue(),
      '250',
    );
    await page.locator('[data-bulk-undo]').click();
    assert.equal(
      await page
        .getByLabel('Medium, Mid back price', { exact: true })
        .inputValue(),
      '195.5',
    );
    assert.equal(
      await page.locator('[data-dirty-status]').textContent(),
      'Unsaved changes',
    );
    await page.locator('[data-bulk-apply]').click();
    await save(page.getByRole('button', { name: 'Save changes' }));
    assert.deepEqual(
      (await repo.catalog()).styles
        .find((style) => style.slug === 'studio-braids-' + width)
        .variants.map((v) => v.priceCents),
      [20550, 25000],
    );
    await page.locator('.price-history summary').click();
    assert.ok(
      (await page.locator('.price-history').textContent()).includes(
        '$195.50 → $205.50',
      ),
    );
    for (const section of ['details', 'prices', 'search', 'photos']) {
      await page.locator(`[data-section="${section}"]`).click();
      assert.deepEqual(
        (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id),
        [],
        section + ' accessibility at ' + width,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        section + ' overflow at ' + width,
      );
      await page.screenshot({
        path: `tmp/qa/manage-style-${section}-${width}.png`,
        fullPage: true,
      });
    }
    assert.equal(
      (await fetch(origin + '/styles/studio-braids-' + width)).status,
      200,
    );
    await page.getByRole('button', { name: 'Add photo', exact: true }).click();
    const photo = page.locator('#photo-add form');
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
    const publicPage = await fetch(origin + '/styles/studio-braids-' + width);
    assert.ok((await publicPage.text()).includes('/media/catalog/'));
    await page.goto(origin + '/admin/gallery');
    const initialStyle = (await repo.catalog()).styles.find(
      (style) => style.slug === 'studio-braids-' + width,
    );
    const originalPhoto = initialStyle.photos[0];
    const photoDialog = page.locator('#photo-window');
    await page.getByLabel('Search photos').fill('studio braid style for QA');
    const card = page.locator('[data-photo-id="' + originalPhoto.id + '"]');
    await card.locator('[data-photo-edit]').click();
    await photoDialog.locator('[data-window-file]').setInputFiles({
      name: 'replacement.jpg',
      mimeType: 'image/jpeg',
      buffer: image,
    });
    await photoDialog.getByText('New image chosen').waitFor();
    await save(
      photoDialog.getByRole('button', { name: 'Save photo', exact: true }),
    );
    const changed = (await repo.catalog()).styles.find(
      (style) => style.id === initialStyle.id,
    ).photos[0];
    for (const key of ['id', 'alt', 'sort', 'styleId'])
      assert.equal(changed[key], originalPhoto[key]);
    assert.notEqual(changed.path, originalPhoto.path);
    await card.locator('[data-photo-edit]').click();
    await photoDialog.getByRole('button', { name: 'Remove photo' }).click();
    const confirmation = page.locator('#owner-confirm-dialog');
    await confirmation.waitFor({ state: 'visible' });
    assert.equal(nativeDialogs, 0);
    await page.keyboard.press('Escape');
    await confirmation.waitFor({ state: 'hidden' });
    await photoDialog.getByRole('button', { name: 'Remove photo' }).click();
    await save(
      confirmation.getByRole('button', { name: 'Remove photo', exact: true }),
    );
    const missing = page.locator(
      '[data-missing-style="' + initialStyle.id + '"]',
    );
    assert.ok((await missing.textContent()).includes(initialStyle.name));
    assert.equal(
      (await repo.catalog()).styles.find((x) => x.id === initialStyle.id).photos
        .length,
      0,
    );
    await save(page.getByRole('button', { name: 'Undo', exact: true }));
    assert.equal(
      (await repo.catalog()).styles.find((x) => x.id === initialStyle.id).photos
        .length,
      1,
    );
    await page.goto(editURL + '#style-photos');
    await page.locator('[data-photo-edit]').first().click();
    const styleReplacement = page.locator('#photo-edit [data-replace-form]');
    await styleReplacement
      .getByLabel('Replace with another image', { exact: true })
      .setInputFiles({
        name: 'style-replacement.jpg',
        mimeType: 'image/jpeg',
        buffer: image,
      });
    await save(
      styleReplacement.getByRole('button', {
        name: 'Replace photo',
        exact: true,
      }),
    );
    await page.goto(origin + '/admin/addons');
    await page.getByRole('button', { name: 'Add extra', exact: true }).click();
    const extra = page.locator('#extra-dialog form');
    await extra.getByLabel('Name', { exact: true }).fill('Beads ' + width);
    await extra.getByLabel('Price (USD)').fill('15');
    await save(extra.getByRole('button', { name: 'Save extra' }));
    await page.waitForLoadState('networkidle');
    assert.ok(
      (await repo.catalog()).addons.some((a) => a.slug === 'beads-' + width),
    );
    const flagSaved = () =>
      page.waitForResponse((r) => /\/(active|flags)$/.test(r.url()));
    const beads = page
      .locator('.extra-row')
      .filter({ hasText: 'Beads ' + width });
    let flagged = flagSaved();
    await beads.getByRole('switch').uncheck();
    await flagged;
    assert.ok(
      !(await repo.catalog()).addons.some((a) => a.slug === 'beads-' + width),
    );
    await page.screenshot({
      path: `tmp/qa/manage-extras-${width}.png`,
      fullPage: true,
    });
    await beads.getByRole('button', { name: /Edit/ }).click();
    await page.waitForTimeout(300);
    assert.equal(
      await page
        .locator('#extra-dialog')
        .getByLabel('Available to book')
        .isChecked(),
      false,
    );
    await page.screenshot({ path: `tmp/qa/manage-extra-edit-${width}.png` });
    // The styles list: search, switches and order.
    await page.goto(origin + '/admin/styles');
    await page.getByLabel('Search styles').fill('studio braids ' + width);
    assert.equal(await page.locator('.style-row:visible').count(), 1);
    flagged = flagSaved();
    await page.locator('.style-row:visible [data-flag="featured"]').check();
    await flagged;
    await page.getByLabel('Search styles').fill('');
    await page.getByRole('button', { name: 'Change order' }).click();
    const firstName = await page.locator('.style-row h2').first().textContent();
    await page.locator('[data-order-move="1"]').first().click();
    await page.getByRole('button', { name: 'Save order' }).click();
    await page.getByRole('button', { name: 'Change order' }).waitFor();
    await page.reload();
    assert.equal(
      await page.locator('.style-row h2').nth(1).textContent(),
      firstName,
    );
    assert.equal((await repo.catalog()).styles[1].name, firstName);
    await page.screenshot({
      path: `tmp/qa/manage-style-list-${width}.png`,
      fullPage: true,
    });
    // Pages: 20 styles at a time, kept on reload; ordering shows every style.
    const extraCopies = 25 - (await page.locator('.style-row').count());
    await page.evaluate(async (copies) => {
      const id = document.querySelector('.style-row').dataset.orderId;
      for (let n = 0; n < copies; n++)
        await fetch(`/admin/styles/${id}/duplicate`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'x-csrf-token': document.querySelector('meta[name="csrf-token"]')
              .content,
          },
          body: '{}',
        });
    }, extraCopies);
    await page.reload();
    const visible = () => page.locator('.style-row:visible').count();
    const range = () => page.locator('[data-page-range]').textContent();
    assert.equal(await visible(), 20);
    assert.equal(await range(), '1–20 of 25');
    await page.getByRole('button', { name: 'Next →' }).click();
    assert.equal(await visible(), 5);
    assert.equal(await range(), '21–25 of 25');
    assert.deepEqual(
      (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id),
      [],
    );
    await page.screenshot({
      path: `tmp/qa/manage-style-pages-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    assert.equal(await range(), '21–25 of 25');
    await page.getByRole('button', { name: /^Hidden/ }).click();
    assert.equal(await visible(), extraCopies);
    assert.equal(await page.locator('[data-style-pages]').isVisible(), false);
    await page.getByRole('button', { name: 'Change order' }).click();
    assert.equal(await visible(), 25);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Page 2', exact: true }).click();
    assert.equal(await visible(), 5);
    await pool.query(
      "DELETE v FROM style_variants v JOIN styles s ON s.id = v.style_id WHERE s.slug LIKE '%-copy%'",
    );
    await pool.query("DELETE FROM styles WHERE slug LIKE '%-copy%'");
    await page.goto(origin + '/admin/availability');
    await page
      .getByLabel('Shortest notice for online booking (hours)')
      .fill('12');
    await save(
      page.getByRole('button', { name: 'Save opening hours', exact: true }),
    );
    await page.waitForLoadState('networkidle');
    assert.equal((await repo.catalog()).settings.booking.minNoticeHours, 12);
    await page.goto(origin + '/admin/settings');
    await page.getByLabel('Business name').fill('Mado Test Studio ' + width);
    await page.getByText('Unsaved changes').waitFor();
    await save(page.getByRole('button', { name: 'Save business' }));
    await page.waitForLoadState('networkidle');
    await page.goto(origin + '/admin/settings/payments');
    await page.getByLabel('Booking deposit (USD)').fill('35');
    await save(page.getByRole('button', { name: 'Save payments' }));
    await page.waitForLoadState('networkidle');
    await page.goto(origin + '/admin/settings/policies');
    await page
      .getByLabel('Added at the end of the Policies page')
      .fill('Please arrive ten minutes before your appointment.');
    await save(page.getByRole('button', { name: 'Save policies' }));
    await page.waitForLoadState('networkidle');
    assert.equal((await repo.catalog()).settings.booking.depositCents, 3500);
    assert.ok(
      (await (await fetch(origin + '/policies')).text()).includes(
        'Please arrive ten minutes',
      ),
    );
    await page.goto(origin + '/admin/clients?view=unbooked');
    await page
      .locator('.client-row-link')
      .filter({ hasText: 'Test Client' })
      .first()
      .click();
    await page
      .getByLabel('Private notes, only for the studio')
      .fill('Prefers a quiet appointment.');
    await save(page.getByRole('button', { name: 'Save notes' }));
    await page.waitForLoadState('networkidle');
    assert.equal(
      await page.getByLabel('Private notes, only for the studio').inputValue(),
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
