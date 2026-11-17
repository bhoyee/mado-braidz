import { DateTime } from 'luxon';
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const uploadDir = await mkdtemp(join(tmpdir(), 'mado-browser-test-'));
const repo = await memoryBookingRepository();
const app = createApp({
  config: parseEnv({
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-browser-secret-at-least-32-characters',
    DATABASE_URL: 'mysql://unused:unused@localhost/mado',
    UPLOAD_DIR: uploadDir,
  }),
  catalog: fixtureCatalog(),
  bookingRepository: repo,
});
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      hasTouch: width === 390,
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(
      base + '/book?style=knotless-braids&size=medium&variant=101',
    );
    await page.waitForFunction(
      () => document.getElementById('summary-total').textContent === '$180',
    );
    assert.equal(await page.locator('#booking-variant').inputValue(), '101');
    async function check(step) {
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        'horizontal overflow',
      );
      const report = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      assert.deepEqual(
        report.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        })),
        [],
        `Accessibility step ${step}`,
      );
      results.push({ width, step, accessibility: 'pass' });
    }
    await check(1);
    const stylePicker = page.getByRole('combobox', {
      name: 'Style',
      exact: true,
    });
    await stylePicker.click();
    await check('style menu');
    assert.equal(
      await page
        .locator('#booking-style-menu')
        .evaluate((el) => el.scrollHeight > el.clientHeight),
      true,
    );
    if (width === 390) {
      const session = await context.newCDPSession(page);
      const box = await page.locator('#booking-style-menu').boundingBox();
      const x = box.x + box.width / 2,
        y = box.y + box.height - 20;
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y }],
      });
      for (let i = 1; i <= 8; i++)
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x, y: y - i * 20 }],
        });
      await session.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [],
      });
      await session.detach();
    } else {
      await page.locator('#booking-style-menu').hover();
      await page.mouse.wheel(0, 400);
    }
    await page.waitForFunction(
      () => document.getElementById('booking-style-menu').scrollTop > 0,
    );
    assert.equal(await stylePicker.getAttribute('aria-expanded'), 'true');
    await stylePicker.press('Home');
    await stylePicker.press('Enter');
    assert.equal(await page.locator('#booking-style').inputValue(), '1');
    const sizePicker = page.getByRole('combobox', {
      name: 'Braid size',
      exact: true,
    });
    await sizePicker.click();
    await check('size menu');
    await page.getByRole('option', { name: 'Medium', exact: true }).click();
    const lengthPicker = page.getByRole('combobox', {
      name: 'Length',
      exact: true,
    });
    await lengthPicker.click();
    await check('length menu');
    await page.getByRole('option', { name: /Mid back/ }).hover();
    assert.equal(
      await page
        .getByRole('option', { name: /Mid back/ })
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      'rgb(95, 45, 158)',
    );
    await lengthPicker.press('Home');
    await lengthPicker.press('Enter');
    await page.waitForFunction(
      () => document.getElementById('summary-total').textContent === '$180',
    );

    // Repeated activation of the same Continue button must not skip extras.
    await page
      .getByRole('button', { name: 'Choose extras', exact: true })
      .evaluate((button) => {
        button.click();
        button.click();
      });
    assert.equal(
      await page.locator('[data-booking-step="2"]').isVisible(),
      true,
    );
    assert.equal(
      await page.getByRole('checkbox', { name: /Head wash/ }).isVisible(),
      true,
    );
    await page.getByRole('checkbox', { name: /100% human hair/ }).check();
    await page.waitForFunction(
      () => document.getElementById('summary-total').textContent === '$220',
    );
    await check(2);
    await page
      .getByRole('button', { name: 'Find a time', exact: true })
      .click();
    await page.locator('#booking-calendar button:enabled').first().click();
    await page.locator('#booking-slots button:enabled').first().click();
    assert.deepEqual(
      await page.locator('.booking-time-period h3').allTextContents(),
      ['Morning', 'Afternoon', 'Evening'],
    );
    const columns = await page
      .locator('.booking-time-grid')
      .first()
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
      );
    assert.equal(columns, width === 390 ? 2 : 4);
    for (const period of await page.locator('.booking-time-period').all()) {
      const name = await period.locator('h3').innerText();
      for (const text of await period.locator('button').allTextContents()) {
        const match = text.match(/^(\d+):\d+ (AM|PM)/);
        const hour = (Number(match[1]) % 12) + (match[2] === 'PM' ? 12 : 0);
        assert.equal(
          hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening',
          name,
        );
      }
    }
    const times = page.locator('#booking-slots button:enabled');
    if ((await times.count()) > 1) {
      await times.nth(1).click();
      assert.equal(
        await page.locator('#booking-slots button[aria-pressed=true]').count(),
        1,
      );
    }
    await page.screenshot({
      path: `tmp/qa/booking-time-periods-${width}.png`,
      fullPage: true,
    });

    await check(3);
    await page
      .getByRole('button', { name: 'Your details', exact: true })
      .click();
    await page
      .getByLabel('Full name', { exact: true })
      .fill('Browser Test Client');
    await page
      .getByLabel('Email', { exact: true })
      .fill('browser@example.test');

    await page
      .getByRole('button', { name: 'Hold this time for 30 minutes' })
      .click();
    assert.equal(
      await page.locator('#booking-phone-error').innerText(),
      'Required field',
    );
    assert.equal(
      await page.locator('#booking-phone').getAttribute('aria-invalid'),
      'true',
    );
    await page.getByLabel('Phone', { exact: true }).fill('+2348031234567');
    await page.getByLabel('Phone', { exact: true }).blur();
    assert.equal(
      await page.locator('#booking-phone-error').innerText(),
      'Invalid phone number',
    );
    assert.equal(
      await page
        .locator('#booking-phone-error')
        .evaluate((el) => getComputedStyle(el).color),
      'rgb(179, 38, 30)',
    );
    assert.equal(
      await page
        .locator('#booking-phone')
        .evaluate((el) => getComputedStyle(el).borderColor),
      'rgb(179, 38, 30)',
    );
    await check('red validation');
    await page.getByLabel('Phone', { exact: true }).fill('4437434979');
    await page.getByLabel('Phone', { exact: true }).blur();
    assert.equal(
      await page.locator('#booking-phone').getAttribute('aria-invalid'),
      null,
    );
    await page.getByRole('checkbox', { name: /I accept the/ }).check();

    await check(4);
    await page.goBack();
    await page.locator('[data-booking-step="3"]:visible').waitFor();
    await page.goForward();
    await page.locator('[data-booking-step="4"]:visible').waitFor();
    await page.reload();
    await page.waitForFunction(
      () => !document.querySelector('[data-booking-step="4"]').hidden,
    );
    assert.equal(
      await page.getByLabel('Full name', { exact: true }).inputValue(),
      'Browser Test Client',
    );
    assert.match(await page.locator('#summary-time').innerText(), /Eastern/);
    if (width === 390) {
      await page
        .getByRole('button', { name: /View your visit summary/ })
        .click();
      await check('summary');
      await page
        .getByRole('button', { name: /View your visit summary/ })
        .click();
    }
    await page.getByRole('checkbox', { name: /I accept the/ }).check();
    assert.equal(await page.locator('#booking-marketing').isChecked(), false);
    await page.screenshot({
      path: `tmp/qa/booking-details-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole('button', { name: 'Hold this time for 30 minutes' })
      .click();
    await page.locator('#booking-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#booking-reference').innerText(), /MADO-/);
    assert.match(
      await page.locator('#booking-result-message').innerText(),
      /not confirmed/,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  // Existing three overlapping appointments grey out the entire affected range.
  const context = await browser.newContext({
    viewport: { width: 390, height: 1000 },
  });
  const page = await context.newPage();
  const row = repo.rows[0];
  repo.rows.splice(
    0,
    repo.rows.length,
    row,
    { ...row, ref: 'QA-SECOND' },
    { ...row, ref: 'QA-THIRD' },
  );
  const heldDate = DateTime.fromJSDate(row.startAt)
    .setZone('America/New_York')
    .toISODate();
  await page.goto(base + '/book?style=knotless-braids&variant=101&step=3');
  const heldDay = page.getByRole('button', {
    name: new RegExp('^' + heldDate),
  });
  await heldDay.waitFor();
  if (await heldDay.isEnabled()) {
    await heldDay.click();
    await page.waitForFunction(
      () => document.querySelectorAll('#booking-slots button').length > 0,
    );
    assert.ok(
      (await page.locator('#booking-slots button:disabled').count()) > 0,
    );
  } else assert.equal(await heldDay.isDisabled(), true);
  await context.close();
  console.log(
    JSON.stringify({
      cases: results,
      capacityGreyOut: 'pass',
      refresh: 'pass',
      temporaryHold: 'pass',
    }),
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(uploadDir, { recursive: true, force: true });
}
