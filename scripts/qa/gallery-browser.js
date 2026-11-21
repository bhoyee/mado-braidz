import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import mysql from 'mysql2/promise';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import sharp from 'sharp';
import { createDatabase } from '../../src/db/index.js';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { createManagementService } from '../../src/services/managementService.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';

const name = 'mado_gallery_test_' + randomBytes(6).toString('hex');
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
const admin = await mysql.createConnection(source.toString());
const uploadDir = resolve('tmp', name);
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
    UPLOAD_DIR: uploadDir,
  };
  const seed = spawnSync(process.execPath, ['scripts/seed.js'], {
    env: { ...process.env, ...settings },
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, 'Disposable gallery seed failed');
  const service = createManagementService(database.db);
  const actor = { id: 1, role: 'owner', ip: '127.0.0.1' };
  app = createApp({
    config: parseEnv(settings),
    stripeProvider: fakeStripe(),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  await mkdir('tmp/qa', { recursive: true });
  const image = await sharp({
    create: { width: 480, height: 600, channels: 3, background: '#846493' },
  })
    .jpeg()
    .toBuffer();
  const replacement = await sharp({
    create: { width: 480, height: 600, channels: 3, background: '#59406f' },
  })
    .png()
    .toBuffer();
  for (const width of [390, 1440]) {
    const missingId = await service.saveStyle(
      null,
      {
        name: 'Portfolio test style ' + width,
        categoryId: 1,
        durationMin: 240,
        priceOnConsultation: true,
        active: false,
        featured: false,
      },
      actor,
    );
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', async (d) => {
      errors.push('Unexpected native dialog');
      await d.dismiss();
    });
    const save = async (button) => {
      await Promise.all([
        page.waitForEvent(
          'framenavigated',
          (frame) => frame === page.mainFrame(),
        ),
        button.click(),
      ]);
      await page.waitForLoadState('networkidle');
    };
    const accessible = async (label) =>
      assert.deepEqual(
        (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        label,
      );
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill(settings.ADMIN_EMAIL);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    await page.goto(origin + '/admin/gallery');
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.ok((await page.locator('.library-card').count()) > 1);
    assert.ok(
      (await page
        .locator('.library-card')
        .first()
        .getAttribute('data-photo-name')) !== 'Portfolio photo',
    );
    await accessible('Photo library');
    await page.screenshot({
      path: `tmp/qa/gallery-library-${width}.png`,
      fullPage: true,
      timeout: 60000,
    });
    await page
      .getByLabel('Search photos', { exact: true })
      .fill('no photo should match this phrase');
    await page.locator('[data-library-empty]:not([hidden])').waitFor();
    assert.equal(await page.locator('.library-card:not([hidden])').count(), 0);
    await page.getByLabel('Search photos', { exact: true }).fill('');
    const firstStyle = await page
      .locator('.library-card')
      .first()
      .getAttribute('data-photo-style');
    await page.locator('[data-library-style]').selectOption(firstStyle);
    assert.ok(
      (
        await page
          .locator('.library-card:not([hidden])')
          .evaluateAll((rows) => rows.map((r) => r.dataset.photoStyle))
      ).every((id) => id === firstStyle),
    );
    await page.locator('[data-library-style]').selectOption('');
    await page.locator('.library-missing > summary').click();
    await page.locator(`[data-missing-style="${missingId}"] button`).click();
    const upload = page.locator('#library-upload-dialog');
    assert.equal(
      await upload.locator('[name=styleId]').inputValue(),
      String(missingId),
    );
    assert.equal(await upload.locator('[name=kind]').inputValue(), 'style');
    await upload.locator('[name=photo]').setInputFiles({
      name: 'style.jpg',
      mimeType: 'image/jpeg',
      buffer: image,
    });
    await save(
      upload.getByRole('button', { name: 'Upload photo', exact: true }),
    );
    assert.equal(
      (await service.all()).media.filter((photo) => photo.styleId === missingId)
        .length,
      1,
    );
    await page.getByRole('button', { name: 'Add photo', exact: true }).click();
    await upload.locator('[name=photo]').setInputFiles({
      name: 'portfolio.jpg',
      mimeType: 'image/jpeg',
      buffer: image,
    });
    assert.equal(
      await upload.locator('[data-gallery-upload-preview]').isVisible(),
      true,
    );
    await upload
      .getByLabel('Photo description', { exact: true })
      .fill('Gallery browser test ' + width);
    await accessible('Upload dialog');
    await save(
      upload.getByRole('button', { name: 'Upload photo', exact: true }),
    );
    const id = Number(new URL(page.url()).hash.replace('#photo-', ''));
    assert.ok(id);
    const card = page.locator(`#photo-${id}`);
    await page
      .getByRole('button', { name: 'Style pages', exact: true })
      .click();
    assert.equal(await card.isVisible(), false);
    await page.getByRole('button', { name: 'Our Work', exact: true }).click();
    assert.equal(await card.isVisible(), true);
    await card.getByRole('button', { name: /Manage photo/ }).click();
    const edit = page.locator('#library-edit-dialog');
    const form = edit.locator('[data-gallery-edit-form]');
    await form.getByLabel('Photo description', { exact: true }).fill('x');
    await form.getByRole('button', { name: 'Save photo details' }).click();
    await form.locator('[data-owner-form-error]:not([hidden])').waitFor();
    await form
      .getByLabel('Photo description', { exact: true })
      .fill('Updated portfolio ' + width);
    await accessible('Manage photo dialog');
    await page.screenshot({
      path: `tmp/qa/gallery-manage-${width}.png`,
      timeout: 60000,
    });
    await save(form.getByRole('button', { name: 'Save photo details' }));
    await card.getByRole('button', { name: /Manage photo/ }).click();
    const before = await service.media(id);
    await edit.getByLabel('New photo', { exact: true }).setInputFiles({
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: replacement,
    });
    await save(
      edit.getByRole('button', { name: 'Replace photo', exact: true }),
    );
    const after = await service.media(id);
    assert.notEqual(after.path, before.path);
    for (const key of ['id', 'alt', 'styleId', 'kind', 'sort'])
      assert.equal(after[key], before[key]);
    await page
      .getByRole('button', { name: 'Reorder photos', exact: true })
      .click();
    const initial = await page
      .locator('[data-photo-id]')
      .evaluateAll((rows) => rows.map((r) => r.dataset.photoId));
    await page.locator('[data-photo-move="1"]').first().click();
    await page.locator('[data-photo-reorder-cancel]').click();
    assert.deepEqual(
      await page
        .locator('[data-photo-id]')
        .evaluateAll((rows) => rows.map((r) => r.dataset.photoId)),
      initial,
    );
    await page
      .getByRole('button', { name: 'Reorder photos', exact: true })
      .click();
    await page.locator('[data-photo-move="1"]').first().click();
    const expected = await page
      .locator('[data-photo-id]')
      .evaluateAll((rows) => rows.map((r) => Number(r.dataset.photoId)));
    await save(
      page.getByRole('button', { name: 'Save photo order', exact: true }),
    );
    assert.deepEqual(
      (await service.all()).media.map((r) => r.id),
      expected,
    );
    await card.getByRole('button', { name: /Manage photo/ }).click();
    await edit
      .getByRole('button', { name: 'Remove photo', exact: true })
      .click();
    const confirm = page.locator('#owner-confirm-dialog');
    await accessible('Remove confirmation');
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await edit.isVisible(), true);
    await edit
      .getByRole('button', { name: 'Remove photo', exact: true })
      .click();
    await save(
      confirm.getByRole('button', { name: 'Remove photo', exact: true }),
    );
    assert.equal(await card.count(), 0);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: search, filters, missing-style upload, image preview, edit validation, replacement, reorder/cancel/save, confirmed removal and accessibility.`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await app?.locals.closeDatabase();
  await pool?.end();
  if (uploadDir.startsWith(resolve('tmp') + sep + 'mado_gallery_test_'))
    await rm(uploadDir, { recursive: true, force: true });
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}
