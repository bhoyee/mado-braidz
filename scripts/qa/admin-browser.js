import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { DateTime } from 'luxon';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import {
  memoryAdminRepository,
  futureStart,
} from '../../tests/fixtures/admin.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';

const repo = await memoryBookingRepository();
const password = randomBytes(24).toString('hex');
const admins = memoryAdminRepository(repo, {
  id: 1,
  role: 'owner',
  name: 'Mado Owner',
  email: 'owner@example.test',
  passwordHash: await argon2.hash(password),
  authVersion: 0,
});
const app = createApp({
  config: parseEnv({ ...paymentConfig, UPLOAD_DIR: 'tmp/admin-browser' }),
  bookingRepository: repo,
  adminRepository: admins,
  catalog: fixtureCatalog(),
  stripeProvider: fakeStripe(),
});
const server = app.listen(0, '127.0.0.1');
await new Promise((done) => server.once('listening', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage(),
      errors = [],
      violations = [];
    const moveRequests = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/move'))
        moveRequests.push({ url: req.url(), body: req.postDataJSON() });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        /Content Security Policy|Refused to/.test(message.text())
      )
        errors.push(message.text());
    });
    await page.goto(origin + '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    console.log(`Owner signed in at ${width}px`);
    await page.goto(origin + '/admin/bookings/new');
    await page.getByLabel('Full name').fill(`Browser Client ${width}`);
    await page
      .getByLabel('Email', { exact: true })
      .fill(`browser-${width}@example.test`);
    await page.getByLabel('US phone number').fill('4437434979');
    const start = DateTime.fromISO(futureStart())
      .setZone('America/New_York')
      .plus({ days: width === 390 ? 0 : 1 });
    await page.getByLabel('Date', { exact: true }).fill(start.toISODate());
    await page.getByLabel('Start time').fill('09:00');
    await page.getByLabel('Payment arrangement').selectOption('override');
    await page.getByRole('button', { name: 'Show available times' }).click();
    await page.locator('[data-owner-slots] button').first().waitFor();
    await page.getByRole('button', { name: 'Create appointment' }).click();
    await page.waitForURL(/\/admin\/bookings\/\d+$/);
    console.log(`Owner created appointment at ${width}px`);
    const bookingId = Number(page.url().split('/').pop());
    assert.equal(repo.rows.find((b) => b.id === bookingId).status, 'confirmed');
    async function submitDetailForm(button) {
      const posted = page.waitForResponse(
        (response) => response.request().method() === 'POST',
      );
      await button.click();
      const response = await posted;
      assert.equal(
        new URL(response.url()).pathname,
        `/admin/bookings/${bookingId}/action`,
      );
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-type'], /application\/json/);
      await page.locator('.owner-alert').waitFor({ state: 'visible' });
      assert.equal(
        await page.locator('.owner-alert').textContent(),
        'Booking updated.',
      );
    }
    await page
      .getByLabel('Only visible to the owner')
      .fill('Saved from the private notes form.');
    await page.route(
      `${origin}/admin/bookings/${bookingId}/action`,
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'text/html',
          body: '<!doctype html><title>Unavailable</title>',
        }),
      { times: 1 },
    );
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.locator('.owner-alert').waitFor({ state: 'visible' });
    assert.equal(
      await page.locator('.owner-alert').textContent(),
      'Unable to save. Refresh the page and try again.',
    );
    assert.notEqual(
      (await repo.bookingById(bookingId)).adminNotes,
      'Saved from the private notes form.',
    );
    await submitDetailForm(
      page.getByRole('button', { name: 'Save note', exact: true }),
    );
    assert.equal(
      (await repo.bookingById(bookingId)).adminNotes,
      'Saved from the private notes form.',
    );
    await page.getByLabel('Amount received (USD)').fill('30');
    await page
      .getByLabel('Payment note', { exact: true })
      .fill('Cash received at the studio.');
    await submitDetailForm(
      page.getByRole('button', {
        name: 'Record received payment',
        exact: true,
      }),
    );
    assert.equal((await repo.bookingById(bookingId)).paidCents, 3000);
    assert.equal((await repo.payments(bookingId)).length, 1);
    // The action select used to hide the form's URL property just like the
    // hidden action fields on payment and notes forms.
    await page.locator('select[name="action"]').selectOption('balance-link');
    await page
      .getByLabel('Reason / note', { exact: true })
      .fill('Requested by the client.');
    const queuedResponse = page.waitForResponse(
      (response) => response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: 'Apply action', exact: true })
      .click();
    const queued = await queuedResponse;
    assert.equal(
      new URL(queued.url()).pathname,
      `/admin/bookings/${bookingId}/action`,
    );
    assert.equal(queued.status(), 200);
    await page.locator('.owner-alert').waitFor({ state: 'visible' });
    assert.ok(
      repo.jobRows.some(
        (job) =>
          job.payload.bookingId === bookingId &&
          job.payload.template === 'balance-payment',
      ),
    );
    console.log(
      `PASS private notes, cash payment and booking action forms at ${width}px`,
    );
    await page.screenshot({
      path: `tmp/qa/admin-detail-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole('link', { name: 'Edit appointment', exact: true })
      .click();
    await page
      .getByLabel('Date', { exact: true })
      .fill(start.plus({ days: 2 }).toISODate());
    await page.getByLabel('Start time').fill('10:30');
    await page
      .getByLabel('Private owner notes')
      .fill('Client requested a new appointment time.');
    await page.getByRole('button', { name: 'Save appointment' }).click();
    await page.waitForURL(new RegExp(`/admin/bookings/${bookingId}$`));
    console.log(`Owner edited appointment at ${width}px`);
    let moved = repo.rows.find((b) => b.id === bookingId);
    assert.equal(
      DateTime.fromJSDate(moved.startAt, { zone: 'America/New_York' }).toFormat(
        'HH:mm',
      ),
      '10:30',
    );
    // A confirmed owner override can pay its full balance through the public link.
    const visitUrl = await page.locator('#private-link').inputValue();
    await page.goto(visitUrl.replace('http://localhost:4780', origin));
    assert.equal(
      (await page.getByRole('button', { name: /Pay.*balance/i }).count()) > 0,
      true,
    );
    for (const route of [
      '/admin',
      '/admin/bookings',
      `/admin/bookings/${bookingId}`,
      `/admin/bookings/${bookingId}/edit`,
      '/admin/payment-reviews',
      '/admin/security',
      '/admin/audit',
      '/admin/calendar',
    ]) {
      await page.goto(origin + route);
      if (route === '/admin/calendar') {
        await page.locator('.fc-view-harness').waitFor();
        await page.waitForTimeout(500);
        assert.ok((await page.locator('.fc-timegrid-slot').count()) > 0);
      }
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('body *')]
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.right > innerWidth + 1 &&
              getComputedStyle(el.parentElement).overflowX !== 'auto'
            );
          })
          .map(
            (el) =>
              `${el.tagName}.${el.className}:${Math.round(el.getBoundingClientRect().right)}`,
          )
          .slice(0, 12),
      );
      if (
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        )
      ) {
        console.log(
          await page.locator('.owner-table-wrap').evaluate((el) => ({
            width: el.clientWidth,
            scrollWidth: el.scrollWidth,
            overflow: getComputedStyle(el).overflowX,
            main: document.querySelector('main').clientWidth,
            doc: document.documentElement.scrollWidth,
          })),
        );
        await page.screenshot({
          path: 'tmp/qa/admin-overflow.png',
          fullPage: true,
        });
      }
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `Overflow at ${width}: ${route} ${JSON.stringify(overflowing)}`,
      );
      const axe = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      for (const violation of axe.violations)
        violations.push({
          route,
          id: violation.id,
          nodes: violation.nodes.map((node) => node.target),
        });
    }
    await page.screenshot({
      path: `tmp/qa/admin-calendar-${width}.png`,
      fullPage: true,
    });
    assert.deepEqual(violations, [], JSON.stringify(violations));
    assert.deepEqual(errors, [], JSON.stringify(errors));
    if (width === 1440) {
      const event = page
        .locator('.fc-timegrid-event')
        .filter({ hasText: `Browser Client ${width}` })
        .first();
      // Navigate to the edited appointment's week, independent of today's date.
      for (let n = 0; n < 3 && !(await event.count()); n++) {
        await page.locator('.fc-next-button').click();
        await page.waitForTimeout(300);
      }
      await event.waitFor();
      await event.scrollIntoViewIfNeeded();
      const beforeMove = +moved.startAt;
      const box = await event.boundingBox();
      const halfHour = await page
        .locator('.fc-timegrid-slot')
        .first()
        .boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + 14);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2,
        box.y + 14 + halfHour.height * 2,
        { steps: 20 },
      );
      await page.mouse.up();
      await page.getByRole('dialog').waitFor();
      await page
        .getByRole('button', { name: 'Save new time', exact: true })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('.owner-alert').textContent ===
          'Appointment moved.',
      );
      moved = await repo.bookingById(bookingId);
      assert.equal(
        +moved.startAt - beforeMove,
        3600000,
        JSON.stringify({
          old: new Date(beforeMove).toISOString(),
          current: moved.startAt.toISOString(),
          moveRequests,
          rows: repo.rows.map((r) => ({
            id: r.id,
            startAt: r.startAt,
            clientId: r.clientId,
          })),
          box,
          halfHour,
        }),
      );
      console.log(
        'PASS actual calendar drag, confirmation dialog and saved reschedule',
      );
      await page.screenshot({
        path: `tmp/qa/admin-calendar-${width}.png`,
        fullPage: true,
      });
    }
    const csrf = await page
      .locator('meta[name="csrf-token"]')
      .getAttribute('content');
    // Exercise the same move API used by the drag confirmation dialog.
    const response = await context.request.post(
      origin + `/admin/api/bookings/${bookingId}/move`,
      {
        headers: { 'x-csrf-token': csrf, Accept: 'application/json' },
        data: {
          startAt: DateTime.fromJSDate(moved.startAt).plus({ days: 1 }).toISO(),
          expectedUpdatedAt: moved.updatedAt.toISOString(),
          notifyClient: true,
          requestKey: randomUUID(),
        },
      },
    );
    // Use a standard UUID to exercise the exact production validation.
    if (response.status() !== 200) throw new Error(await response.text());
    await page.goto(origin + `/admin/bookings/${bookingId}`);
    await page.getByLabel('Refund amount (USD)').fill('5');
    await page
      .getByLabel('Reason', { exact: true })
      .fill('Cash returned to the client.');
    page.once('dialog', (dialog) => dialog.accept());
    await submitDetailForm(
      page.getByRole('button', { name: 'Submit refund', exact: true }),
    );
    assert.equal((await repo.bookingById(bookingId)).paidCents, 2500);
    assert.equal(
      (await repo.payments(bookingId)).filter(
        (payment) => payment.type === 'refund',
      ).length,
      1,
    );
    console.log(
      `PASS owner login, create, edit, move, private balance and accessible screens at ${width}px`,
    );
    await context.close();
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
