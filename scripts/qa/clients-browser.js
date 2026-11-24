import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DateTime } from 'luxon';
import { createDatabase } from '../../src/db/index.js';
import * as s from '../../src/db/schema.js';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
import { createBookingRepository } from '../../src/services/bookingRepository.js';
import { createBookingService } from '../../src/services/bookingService.js';
import { validHold } from '../../tests/fixtures/booking.js';

const name = 'mado_clients_test_' + randomBytes(6).toString('hex');
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
const admin = await mysql.createConnection(source.toString());
let pool, server, browser, app;
try {
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  source.pathname = '/' + name;
  const database = createDatabase(source.toString());
  const db = database.db;
  pool = database.pool;
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  const password = randomBytes(24).toString('hex');
  const settings = {
    ...paymentConfig,
    DATABASE_URL: source.toString(),
    ADMIN_EMAIL: 'owner@example.test',
    ADMIN_PASSWORD: password,
    UPLOAD_DIR: 'tmp/clients-browser',
  };
  const seed = spawnSync(process.execPath, ['scripts/seed.js'], {
    env: { ...process.env, ...settings },
    encoding: 'utf8',
  });
  assert.equal(seed.status, 0, 'Disposable database seed failed');
  app = createApp({ config: parseEnv(settings), stripeProvider: fakeStripe() });
  server = app.listen(0, '127.0.0.1');
  await new Promise((done) => server.once('listening', done));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const repo = createBookingRepository(db);
  const service = createBookingService(
    repo,
    undefined,
    settings.SESSION_SECRET,
  );
  const style = (await repo.catalog()).styles.find((x) => x.variants.length);
  const actor = { id: 1, role: 'owner', ip: '127.0.0.1' };
  let slot = 0;
  async function book(who, email, phone, past = 0) {
    const start = DateTime.now()
      .setZone('America/New_York')
      .plus({ days: 5 + slot++ })
      .set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const { id } = await service.createHold(
      {
        ...validHold,
        name: who,
        email,
        phone,
        styleId: style.id,
        styleVariantId: style.variants[0].id,
        startAt: start.toUTC().toISO(),
      },
      null,
      { admin: actor, mode: 'override' },
    );
    if (past) {
      const at = new Date(Date.now() - past * 86400000);
      await db
        .update(s.bookings)
        .set({
          status: 'completed',
          startAt: at,
          endAt: at,
          blockEndAt: at,
          completedAt: at,
          createdAt: new Date(+at - 86400000),
          paidCents: 18000,
          balanceCents: 0,
        })
        .where(eq(s.bookings.id, id));
    }
    return id;
  }
  await book('Ade Bola', 'ade@example.test', '+14437434901', 40);
  await book('Ade Bola', 'ADE@example.test', '+14437434901', 12);
  await book('Ade Bola', 'ade@example.test', '+14437434901');
  await book('Mum Cole', 'mum@example.test', '+14437434902', 120);
  await book('Nia Cole', 'nia@example.test', '+14437434902', 10);
  for (let n = 0; n < 22; n++)
    await book(
      `Client ${String.fromCharCode(65 + n)}`,
      `c${n}@example.test`,
      '+144374350' + String(10 + n),
      20 + n,
    );
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  await mkdir('tmp/qa', { recursive: true });
  for (const width of [1440, 1100, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const tidy = async (label) => {
      assert.deepEqual(
        (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
          id: v.id,
          html: v.nodes[0].html.slice(0, 120),
        })),
        [],
        label + ' accessibility at ' + width,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        label + ' overflow at ' + width,
      );
    };
    const save = async (button) => {
      await Promise.all([
        // Saving replaces the address, then reloads: wait for the reload.
        page.waitForEvent('load'),
        button.click(),
      ]);
      await page.waitForLoadState('networkidle');
    };
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    await page.goto(origin + '/admin/clients');
    assert.equal(await page.locator('.client-row').count(), 20);
    await tidy('Clients');
    await page.screenshot({
      path: `tmp/qa/clients-${width}.png`,
      fullPage: true,
    });
    if (width === 1440) {
      const row = page.locator('.client-row-link').first();
      const look = () =>
        row
          .locator('.owner-view-link')
          .evaluate((el) => getComputedStyle(el).backgroundColor);
      const before = await look();
      await row.hover();
      await page.waitForTimeout(400);
      assert.notEqual(await look(), before, 'hover effect');
    }
    await page.getByRole('link', { name: 'Next →' }).click();
    await page.waitForLoadState('networkidle');
    assert.ok((await page.locator('.client-row').count()) < 20);
    await page.goto(origin + '/admin/clients');
    await page.getByLabel('Search clients').fill('ade bola');
    await page.waitForFunction(
      () => document.querySelectorAll('.client-row').length === 1,
    );
    assert.match(
      await page.locator('.client-row').textContent(),
      /Repeat/,
      'three records, one person',
    );
    await page.getByLabel('Search clients').fill('4901');
    await page.waitForTimeout(700);
    assert.equal(await page.locator('.client-row').count(), 1);
    await page.locator('.client-row-link').click();
    await page.waitForURL(/\/admin\/clients\/\d+$/);
    await page.locator('.client-visit').nth(2).waitFor();
    assert.equal(await page.locator('.client-visit').count(), 3);
    // Long lists scroll inside their own boxes.
    const visits = page.getByRole('region', { name: 'Visit history' });
    for (let n = 0; n < 4; n++)
      await page.evaluate(() => {
        const list = document.querySelector('.client-visits');
        list.append(...[...list.children].map((li) => li.cloneNode(true)));
      });
    assert.ok((await visits.boundingBox()).height <= 441);
    await page.evaluate(() => dispatchEvent(new Event('resize')));
    const more = page.locator('.is-visits + [data-scroll-hint]');
    assert.equal(await more.isVisible(), true);
    await more.click();
    await page.waitForTimeout(600);
    assert.ok((await visits.evaluate((el) => el.scrollTop)) > 100);
    await visits.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await page.waitForTimeout(200);
    assert.equal(await more.isVisible(), false);
    await tidy('Client profile');
    await page.screenshot({
      path: `tmp/qa/client-${width}.png`,
      fullPage: true,
    });
    await page.reload();
    const tag = 'Tag ' + width;
    await page.getByLabel('Add your own tag').fill(tag);
    await page.keyboard.press('Enter');
    await page.getByLabel('Allergy').check();
    await page
      .getByLabel('Private notes, only for the studio')
      .fill('Window seat ' + width);
    await save(page.getByRole('button', { name: 'Save notes' }));
    assert.ok((await page.locator('.client-head').textContent()).includes(tag));
    assert.ok(
      (await page.locator('.client-head').textContent()).includes('Allergy'),
    );
    await page.getByRole('button', { name: 'Edit details' }).click();
    const edit = page.locator('#client-edit');
    await tidy('Edit client');
    await edit.getByLabel('Email').fill('mum@example.test');
    await edit.getByRole('button', { name: 'Save details' }).click();
    await edit.getByText('Join the two clients').waitFor();
    await edit.getByLabel('Email').fill(`ade${width}@example.test`);
    await save(edit.getByRole('button', { name: 'Save details' }));
    assert.equal(await page.locator('.client-visit').count(), 3);
    await page.getByRole('link', { name: 'Book again' }).click();
    await page.waitForURL(/bookings\/new\?client=/);
    assert.equal(await page.getByLabel('Full name').inputValue(), 'Ade Bola');
    assert.equal(
      await page.locator('[data-owner-style]').inputValue(),
      String(style.id),
    );
    if (width === 1440) {
      await page.goto(origin + '/admin/clients?view=match');
      assert.equal(await page.locator('.client-row').count(), 2);
      await page.locator('.client-row-link').first().click();
      await page.waitForURL(/clients\/\d+$/);
      await page.locator('.client-head').waitFor();
      await page.getByRole('button', { name: 'Join as one client' }).click();
      await save(
        page
          .locator('#owner-confirm-dialog')
          .getByRole('button', { name: 'Join clients' }),
      );
      assert.equal(await page.locator('.client-visit').count(), 2);
      await save(page.getByRole('button', { name: 'Undo join' }));
      assert.equal(await page.locator('.client-visit').count(), 1);
      await save(page.getByRole('button', { name: 'Keep apart' }));
      assert.equal(await page.locator('.client-match').count(), 0);
    }
    await page.goto(origin + '/admin/clients?search=Client+A');
    await page
      .locator('.client-row-link')
      .filter({ hasText: /Client/ })
      .first()
      .click();
    await page
      .getByRole('button', { name: 'Remove personal details' })
      .first()
      .click();
    const remove = page.locator('#client-remove');
    await tidy('Remove client');
    await remove.getByLabel('Type REMOVE to confirm').fill('REMOVE');
    if (width === 1440) {
      await save(
        remove.getByRole('button', { name: 'Remove personal details' }),
      );
      assert.match(
        await page.locator('.client-head').textContent(),
        /Removed client/,
      );
      await tidy('Removed client');
    }
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: cards, search, pages, hover, profile, tags and notes, edit, book again, join, undo, keep apart, removal and accessibility.`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await new Promise((done) => (server ? server.close(done) : done()));
  await app?.locals.closeDatabase();
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.end();
}
