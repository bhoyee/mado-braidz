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
    page.setDefaultTimeout(20000);
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
    if (process.argv.includes('--videos-only')) {
      await page.getByRole('button', { name: /^Videos/ }).click();
      assert.ok((await page.locator('[data-video-id]').count()) >= 5);
      await accessible('Video library');
      const original = page.locator('[data-video-id="studio-knotless"]');
      const flagSaved = () =>
        page.waitForResponse((r) => r.url().endsWith('/flags'));
      const setFlag = async (card, name, on) => {
        const done = flagSaved();
        await card.getByRole('switch', { name }).setChecked(on);
        await done;
      };
      await setFlag(original, /^Published/, false);
      assert.ok(
        !(await (await fetch(origin + '/')).text()).includes(
          '/media/studio-knotless.mp4',
        ),
      );
      assert.ok(
        !(await (await fetch(origin + '/our-work')).text()).includes(
          'film-studio-knotless',
        ),
      );
      await setFlag(original, /^Published/, true);
      assert.ok(
        (await (await fetch(origin + '/')).text()).includes(
          '/media/studio-knotless.mp4',
        ),
      );
      await page
        .getByRole('button', { name: 'Add video', exact: true })
        .click();
      const upload = page.locator('#library-video-upload');
      await upload
        .locator('[name=video]')
        .setInputFiles('public/media/studio-knotless.mp4');
      await page.waitForFunction(
        () =>
          document.querySelector('[data-video-upload-form]').elements.poster
            .files.length === 1,
      );
      await upload
        .getByLabel('Video title', { exact: true })
        .fill('Video browser test ' + width);
      await upload
        .getByLabel('Video description', { exact: true })
        .fill('A short studio video for browser verification.');
      await accessible('Video upload dialog');
      await save(
        upload.getByRole('button', { name: 'Upload video', exact: true }),
      );
      const record = (await service.all()).videos.find(
        (v) => v.title === 'Video browser test ' + width,
      );
      assert.ok(record?.src.startsWith('/media/videos/'));
      const range = await page.request.get(origin + record.src, {
        headers: { Range: 'bytes=0-99' },
      });
      assert.equal(range.status(), 206);
      assert.equal((await range.body()).length, 100);
      const publicPage = await context.newPage();
      await publicPage.goto(origin + '/our-work');
      const player = publicPage.locator('#film-' + record.id);
      await player
        .locator('..')
        .getByRole('button', { name: 'Play film', exact: true })
        .click();
      await publicPage.waitForFunction((id) => {
        const v = document.getElementById('film-' + id);
        return v?.videoWidth > 0 && !v.paused;
      }, record.id);
      await publicPage.close();
      const card = page.locator(`[data-video-id="${record.id}"]`);
      await card.getByRole('button', { name: /^Manage video/ }).click();
      const edit = page.locator('#library-video-edit');
      await edit
        .getByLabel('Video title', { exact: true })
        .fill('Updated video ' + width);
      await accessible('Video management dialog');
      await save(edit.getByRole('button', { name: 'Save video', exact: true }));
      assert.ok(
        (await (await fetch(origin + '/our-work')).text()).includes(
          'Updated video ' + width,
        ),
      );
      await card.getByRole('button', { name: /^Manage video/ }).click();
      const coverChoice = edit.locator('[data-cover-file]');
      await Promise.all([
        page.waitForEvent('framenavigated'),
        coverChoice.setInputFiles({
          name: 'cover.jpg',
          mimeType: 'image/jpeg',
          buffer: image,
        }),
      ]);
      await page.waitForLoadState('networkidle');
      assert.notEqual(
        (await service.all()).videos.find((v) => v.id === record.id).poster,
        record.poster,
      );
      await setFlag(card, /^Published/, false);
      assert.ok(
        !(await (await fetch(origin + '/our-work')).text()).includes(
          record.src,
        ),
      );
      await card.getByRole('button', { name: /^Manage video/ }).click();
      await edit.getByRole('button', { name: 'Remove video' }).click();
      await save(
        page
          .locator('#owner-confirm-dialog')
          .getByRole('button', { name: 'Remove video', exact: true }),
      );
      assert.equal(await card.count(), 0);
      const csrf = await page
        .locator('meta[name="csrf-token"]')
        .getAttribute('content');
      const invalid = await page.request.post(
        origin + '/admin/gallery/videos/upload',
        {
          headers: { Accept: 'application/json', 'x-csrf-token': csrf },
          multipart: {
            title: 'Not a video',
            description: 'Malformed upload check',
            enabled: 'true',
            showInWork: 'true',
            video: {
              name: 'fake.mp4',
              mimeType: 'video/mp4',
              buffer: Buffer.from('<html>invalid video</html>'),
            },
            poster: {
              name: 'cover.jpg',
              mimeType: 'image/jpeg',
              buffer: image,
            },
          },
        },
      );
      assert.equal(invalid.status(), 400);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: `tmp/qa/video-library-${width}.png`,
        fullPage: true,
        timeout: 60000,
      });
      assert.deepEqual(errors, []);
      console.log(
        `PASS ${width}px: existing clip hide/publish, real MP4 upload, automatic cover, public playback, byte ranges, details, malformed-file rejection and accessibility.`,
      );
      await context.close();
      continue;
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const cards = () => page.locator('[data-photo-id]:visible');
    const total = await page.locator('[data-removed=""]').count();
    assert.ok(total > 1);
    assert.equal(await cards().count(), Math.min(20, total));
    // Cards use small copies, never the full-size photo.
    assert.ok(
      (
        await page
          .locator('[data-photo-id] img')
          .evaluateAll((all) => all.map((i) => i.getAttribute('src')))
      ).every((src) => !src.includes('-1600')),
    );
    await accessible('Photo library');
    await page.screenshot({
      path: `tmp/qa/gallery-library-${width}.png`,
      fullPage: true,
      timeout: 60000,
    });
    await page.getByLabel('Search photos').fill('no photo should match this');
    await page.locator('[data-library-empty]:not([hidden])').waitFor();
    assert.equal(await cards().count(), 0);
    await page.getByLabel('Search photos').fill('');
    const firstStyle = await page
      .locator('[data-photo-id][data-style]:not([data-style=""])')
      .first()
      .getAttribute('data-style');
    await page.locator('[data-library-style]').selectOption(firstStyle);
    assert.ok(
      (
        await cards().evaluateAll((rows) => rows.map((r) => r.dataset.style))
      ).every((id) => id === firstStyle),
    );
    await page.locator('[data-library-style]').selectOption('');
    // The Our Work tab is exactly what the public page shows.
    const publicHtml = await (await fetch(origin + '/our-work')).text();
    const inWork = await page
      .locator('[data-in-work="yes"]')
      .evaluateAll((rows) => rows.map((r) => r.dataset.full));
    assert.ok(inWork.length > 0);
    for (const path of inWork) assert.ok(publicHtml.includes(path), path);
    // Upload several at once, one for a style without photos.
    const file = (name, buffer = image) => ({
      name,
      mimeType: 'image/jpeg',
      buffer,
    });
    const huge = await sharp({
      create: { width: 5200, height: 3900, channels: 3, background: '#a06a80' },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    await page.locator('.library-missing > summary').first().click();
    await page.locator(`[data-missing-style="${missingId}"] button`).click();
    const upload = page.locator('#photos-add');
    await upload
      .locator('[data-add-files]')
      .setInputFiles([file('one.jpg'), file('two.jpg', huge)]);
    await upload.locator('.add-row').nth(1).waitFor();
    assert.equal(
      await upload.locator('[data-field="style"]').first().inputValue(),
      String(missingId),
    );
    await upload.locator('[data-rotate]').first().click();
    await upload.locator('[data-crop]').nth(1).selectOption('1');
    await upload.locator('[data-field="alt"]').first().fill('x');
    await upload.locator('[data-add-upload]').click();
    await upload.getByText('Describe this photo in a few words.').waitFor();
    await upload
      .locator('[data-field="alt"]')
      .first()
      .fill('Gallery browser test ' + width);
    await accessible('Upload dialog');
    await page.screenshot({
      path: `tmp/qa/gallery-add-${width}.png`,
      timeout: 60000,
    });
    // A failed photo can be tried again without sending the others twice.
    await page.route(
      '**/admin/gallery/upload',
      (route) => route.fulfill({ status: 503, body: 'busy' }),
      { times: 1 },
    );
    await upload.locator('[data-add-upload]').click();
    await upload.getByText('1 did not upload').waitFor({ timeout: 60000 });
    await save(upload.locator('[data-add-upload]'));
    const added = (await service.all()).media.filter(
      (photo) => photo.styleId === missingId,
    );
    assert.equal(added.length, 2);
    const rotated = added.find((photo) => photo.alt.startsWith('Gallery'));
    const square = added.find((photo) => photo !== rotated);
    assert.ok(rotated.width > rotated.height, 'rotated');
    assert.equal(square.width, square.height);
    // The switch, the window and focus.
    const id = rotated.id;
    const card = page.locator(`#photo-${id}`);
    await page.getByLabel('Search photos').fill('Gallery browser test');
    const placed = page.waitForResponse((r) => r.url().endsWith('/place'));
    await card.getByRole('switch').check();
    await placed;
    assert.equal((await service.media(id)).variants.showInWork, true);
    await card.locator('[data-photo-edit]').click();
    const edit = page.locator('#photo-window');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-window-image-status]').textContent === '',
    );
    assert.equal(
      await edit.locator('[name="showInWork"]').isChecked(),
      true,
      'never silently unticked',
    );
    const box = await edit.locator('[data-window-canvas]').boundingBox();
    await page.mouse.click(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await edit.locator('[name="alt"]').fill('Updated portfolio ' + width);
    await accessible('Photo window');
    await page.screenshot({
      path: `tmp/qa/gallery-manage-${width}.png`,
      timeout: 60000,
    });
    const before = await service.media(id);
    await save(edit.getByRole('button', { name: 'Save photo', exact: true }));
    let after = await service.media(id);
    assert.equal(after.path, before.path);
    assert.deepEqual(after.variants.focus, { x: 20, y: 80 });
    assert.equal(after.variants.showInWork, true);
    await page.getByLabel('Search photos').fill('Updated portfolio');
    await card.locator('[data-photo-edit]').click();
    await edit.locator('[data-window-file]').setInputFiles({
      name: 'replacement.png',
      mimeType: 'image/png',
      buffer: replacement,
    });
    await edit.getByText('New image chosen').waitFor();
    await save(edit.getByRole('button', { name: 'Save photo', exact: true }));
    after = await service.media(id);
    assert.notEqual(after.path, before.path);
    for (const key of ['id', 'styleId', 'kind', 'sort'])
      assert.equal(after[key], before[key]);
    // Next and previous, guarding unsaved work.
    await page.getByLabel('Search photos').fill('');
    await page.locator('[data-photo-view="all"]').click();
    await page.locator('[data-photo-edit]').first().click();
    assert.match(
      await edit.locator('[data-window-position]').textContent(),
      /^Photo 1 of /,
    );
    await edit.getByRole('button', { name: 'Next →' }).click();
    assert.match(
      await edit.locator('[data-window-position]').textContent(),
      /^Photo 2 of /,
    );
    await edit.locator('[name="alt"]').fill('Not saved');
    await edit.getByRole('button', { name: 'Next →' }).click();
    assert.match(
      await edit.locator('[data-window-position]').textContent(),
      /^Photo 2 of /,
    );
    await page.keyboard.press('Escape');
    // Select several, remove, undo.
    await page
      .getByLabel('Search photos')
      .fill('Portfolio test style ' + width);
    await page.getByRole('button', { name: 'Select several' }).click();
    await page.getByRole('button', { name: 'Select all shown' }).click();
    await accessible('Selecting photos');
    await page.screenshot({
      path: `tmp/qa/gallery-select-${width}.png`,
      timeout: 60000,
    });
    await page.locator('[data-bulk="remove"]').click();
    const confirm = page.locator('#owner-confirm-dialog');
    await accessible('Remove confirmation');
    await save(confirm.getByRole('button', { name: 'Remove photos' }));
    const mine = async () =>
      (await service.all()).media.filter((p) => p.styleId === missingId).length;
    assert.equal(await mine(), 0);
    await save(page.getByRole('button', { name: 'Undo', exact: true }));
    assert.equal(await mine(), 2);
    await service.trashMedia([square.id], actor);
    await page.reload();
    await page.locator('[data-photo-view="removed"]').click();
    await save(page.locator(`[data-restore="${square.id}"]`));
    assert.equal(await mine(), 2);
    // Our Work order matches the public page before and after.
    const publicKeys = async () => {
      const visitor = await context.newPage();
      await visitor.goto(origin + '/our-work');
      const paths = await visitor
        .locator('.work-tile')
        .evaluateAll((tiles) =>
          tiles.map(
            (tile) =>
              tile.dataset.workPhoto || tile.querySelector('video')?.id || '',
          ),
        );
      await visitor.close();
      return paths;
    };
    await page.goto(origin + '/admin/gallery#work');
    await page.reload();
    const ordered = await publicKeys();
    assert.equal(await page.locator('[data-work-key]').count(), ordered.length);
    await accessible('Our Work order');
    await page.screenshot({
      path: `tmp/qa/gallery-order-${width}.png`,
      fullPage: true,
      timeout: 60000,
    });
    await page.locator('[data-work-move="1"]').first().click();
    const orderSaved = page.waitForResponse((r) =>
      r.url().endsWith('/work-order'),
    );
    await page.getByRole('button', { name: 'Save order' }).click();
    await orderSaved;
    const moved = await publicKeys();
    assert.equal(moved[1], ordered[0]);
    assert.equal(moved[0], ordered[1]);
    // The public page: filters and the larger view.
    const visitor = await context.newPage();
    visitor.on('pageerror', (e) => errors.push(e.message));
    await visitor.goto(origin + '/our-work');
    await visitor.getByRole('button', { name: 'Films', exact: true }).click();
    assert.equal(
      await visitor.locator('.work-tile:visible').count(),
      await visitor.locator('.work-film').count(),
    );
    await visitor.getByRole('button', { name: 'Everything' }).click();
    const opener = visitor.locator('.work-tile[data-work-photo]').first();
    await opener.click();
    await visitor.locator('[data-work-viewer][open]').waitFor();
    await visitor.getByRole('button', { name: 'Next photo' }).click();
    await visitor.waitForTimeout(400);
    assert.deepEqual(
      (await new AxeBuilder({ page: visitor }).analyze()).violations.map(
        (v) => v.id,
      ),
      [],
      'Our Work viewer',
    );
    await visitor.screenshot({ path: `tmp/qa/our-work-viewer-${width}.png` });
    await visitor.keyboard.press('Escape');
    assert.equal(
      await visitor.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await visitor.screenshot({
      path: `tmp/qa/our-work-${width}.png`,
      fullPage: true,
      timeout: 60000,
    });
    await visitor.close();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: search, filters, multi-upload with retry, rotate, crop, focus, replacement, next/previous, bulk removal, undo, restore, Our Work order, public filters and viewer, accessibility.`,
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
