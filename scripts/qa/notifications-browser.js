import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { fixtureCatalog } from '../../tests/fixtures/catalog.js';
import { memoryBookingRepository } from '../../tests/fixtures/booking.js';
import { memoryAdminRepository } from '../../tests/fixtures/admin.js';
import { paymentConfig, fakeStripe } from '../../tests/fixtures/stripe.js';
import { createNotificationService } from '../../src/services/notificationService.js';
const bookingRepo = await memoryBookingRepository();
const password = randomBytes(24).toString('hex');
const admins = memoryAdminRepository(bookingRepo, {
  id: 1,
  role: 'owner',
  name: 'Mado Owner',
  email: 'owner@example.test',
  passwordHash: await argon2.hash(password),
  authVersion: 0,
});
const items = [
  {
    id: 1,
    type: 'booking_confirmed',
    title: 'A chair is booked',
    body: 'An appointment update is ready.',
    url: '/admin/bookings',
    createdAt: new Date(),
    readAt: null,
  },
];
for (let index = 2; index <= 15; index++)
  items.push({ ...items[0], id: index });
const jobs = [],
  settings = {};
const repo = {
  notifications: async () => ({
    items,
    unread: items.filter((n) => !n.readAt).length,
  }),
  markRead: async () => items.forEach((n) => (n.readAt = new Date())),
  context: async () => ({ settings }),
  saveTemplates: async (value) => {
    settings.emailTemplates = value;
  },
  queue: async (job) => jobs.push(job),
};
const config = parseEnv({
  ...paymentConfig,
  EMAIL_ENABLED: 'true',
  EMAIL_PROVIDER: 'log',
  ADMIN_EMAIL: 'owner@example.test',
  TURNSTILE_ENABLED: 'false',
  VAPID_PUBLIC_KEY: 'B' + 'A'.repeat(86),
});
const service = createNotificationService(repo, config);
const app = createApp({
  config,
  bookingRepository: bookingRepo,
  adminRepository: admins,
  catalog: fixtureCatalog(),
  stripeProvider: fakeStripe(),
  notificationService: service,
});
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    items.forEach((item) => {
      item.readAt = null;
    });
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
        ...(width === 390
          ? {
              userAgent:
                'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
            }
          : {}),
      }),
      page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin + '/admin/notifications');
    assert.equal(new URL(page.url()).pathname, '/admin/login');
    await page.getByLabel('Email', { exact: true }).fill('owner@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForURL(origin + '/admin');
    await page.goto(origin + '/admin/notifications');
    await page
      .getByRole('heading', { name: 'Notifications.', exact: true })
      .waitFor();
    await page.locator('[data-notification-count]:not([hidden])').waitFor();
    const bell = page.getByRole('button', { name: /Notifications,.*unread/ });
    await bell.click();
    await page.locator('[data-notification-dropdown]:not([hidden])').waitFor();
    await page.locator('[data-notification-preview] a').first().waitFor();
    assert.equal(
      await page
        .getByRole('link', { name: 'View all notifications' })
        .getAttribute('href'),
      '/admin/notifications',
    );
    await page.screenshot({
      path: 'tmp/qa/notification-dropdown-' + width + '.png',
    });
    await page.keyboard.press('Escape');
    assert.equal(await bell.getAttribute('aria-expanded'), 'false');
    assert.equal(
      await page.locator('.owner-notifications').evaluate((list) => {
        list.scrollTop = 100;
        return list.scrollHeight > list.clientHeight && list.scrollTop > 0;
      }),
      true,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.locator('.owner-notifications-title').evaluate((header) => {
        const heading = header.querySelector('h2').getBoundingClientRect();
        const button = header.querySelector('button').getBoundingClientRect();
        return (
          Math.abs(
            heading.top + heading.height / 2 - button.top - button.height / 2,
          ) < 3
        );
      }),
      true,
      'Recent updates and read-all button must share the same center line',
    );
    const violations = (await new AxeBuilder({ page }).analyze()).violations;
    assert.equal(violations.length, 0, JSON.stringify(violations));
    const manifest = await (
      await page.request.get(origin + '/admin/manifest.webmanifest')
    ).json();
    assert.equal(manifest.scope, '/admin/');
    await page.waitForFunction(
      async () => !!(await navigator.serviceWorker.getRegistration('/admin/')),
    );
    assert.equal(
      (await page.request.get(origin + '/admin/sw.js')).status(),
      200,
    );
    await Promise.all([
      page.waitForEvent('framenavigated', {
        predicate: (frame) => frame === page.mainFrame(),
      }),
      page.getByRole('button', { name: 'Mark all as read' }).click(),
    ]);
    await page.waitForLoadState('networkidle');
    await page
      .locator('.owner-badge')
      .filter({ hasText: '0 unread' })
      .waitFor();
    await page.screenshot({
      path: `tmp/qa/notifications-${width}.png`,
      animations: 'disabled',
    });
    await page.evaluate(() => {
      window.pushPermissionRequests = 0;
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => 'default',
      });
      Notification.requestPermission = async () => {
        window.pushPermissionRequests++;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'granted';
      };
      const registration = {
        pushManager: {
          getSubscription: async () => null,
          subscribe: async () => ({
            toJSON: () => ({
              endpoint: 'https://fcm.googleapis.com/test',
              keys: {},
            }),
          }),
        },
      };
      navigator.serviceWorker.register = async () => registration;
      Object.defineProperty(navigator.serviceWorker, 'ready', {
        configurable: true,
        value: Promise.resolve(registration),
      });
    });
    await page.route('**/admin/api/push-subscriptions', (route) =>
      route.fulfill({
        json: { message: 'Push alerts enabled on this device.' },
      }),
    );
    await page
      .getByRole('switch', {
        name: 'Push notifications on this device',
        exact: true,
      })
      .click();
    await page
      .locator('[data-push-status]')
      .filter({ hasText: 'Push alerts enabled on this device.' })
      .waitFor();
    assert.equal(await page.evaluate(() => window.pushPermissionRequests), 1);
    await page
      .getByRole('switch', { name: 'Push notifications on this device' })
      .uncheck();
    await page
      .locator('[data-push-status]')
      .filter({ hasText: 'Push alerts disabled on this device.' })
      .waitFor();
    await page.evaluate(() =>
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => 'granted',
      }),
    );
    await page
      .getByRole('switch', {
        name: 'Push notifications on this device',
        exact: true,
      })
      .click();
    await page
      .locator('[data-push-status]')
      .filter({ hasText: 'Push alerts enabled on this device.' })
      .waitFor();
    assert.equal(await page.evaluate(() => window.pushPermissionRequests), 1);
    await page.evaluate(() => {
      navigator.serviceWorker.getRegistration = async () => ({
        pushManager: {
          getSubscription: async () => ({
            endpoint: 'https://fcm.googleapis.com/test-device',
          }),
        },
      });
    });
    await page.route('**/admin/api/push-test', async (route) => {
      assert.equal(
        route.request().postDataJSON().endpoint,
        'https://fcm.googleapis.com/test-device',
      );
      await route.fulfill({ json: { message: 'Test sent to this device.' } });
    });
    await page
      .getByRole('button', { name: 'Send test alert', exact: true })
      .click();
    await page
      .locator('[data-push-status]')
      .filter({ hasText: 'Test sent to this device.' })
      .waitFor();
    await page.locator('[data-push-switch]').evaluate((input) => {
      input.checked = false;
    });
    await page.evaluate(() => {
      Object.defineProperty(Notification, 'permission', {
        configurable: true,
        get: () => 'denied',
      });
      Notification.requestPermission = async () => 'denied';
    });
    await page
      .getByRole('switch', {
        name: 'Push notifications on this device',
        exact: true,
      })
      .click();
    await page
      .locator('[data-push-status]')
      .filter({ hasText: 'Notifications are blocked on this device.' })
      .waitFor();
    if (width === 390)
      assert.match(
        await page.locator('[data-push-status]').innerText(),
        /Android Settings/,
      );
    await page.goto(origin + '/admin/email-templates');
    await page.locator('details').first().locator('summary').click();
    await page
      .locator('input[name="subject"]')
      .first()
      .fill('Your owner reset link');
    await page
      .locator('textarea[name="intro"]')
      .first()
      .fill('Use your private reset link within thirty minutes.');
    await page
      .locator('details')
      .first()
      .getByRole('button', { name: 'Save wording' })
      .click();
    await page.waitForFunction(
      () => !!document.querySelector('.owner-alert:not([hidden])'),
    );
    assert.equal(
      settings.emailTemplates['password-reset'].subject,
      'Your owner reset link',
    );
    await page.getByRole('button', { name: 'Send a test to myself' }).click();
    await page.waitForFunction(() =>
      document
        .querySelector('.owner-alert')
        ?.textContent.includes('Test queued'),
    );
    assert(
      jobs.some(
        (j) =>
          j.payload.template === 'owner-test' &&
          j.payload.to === 'owner@example.test',
      ),
    );
    await page.goto(origin + '/contact');
    await page.getByLabel('Name', { exact: true }).fill('Test Visitor');
    await page
      .getByLabel('Email', { exact: true })
      .fill('visitor@example.test');
    await page
      .getByLabel('Your question')
      .fill('Can you help me choose a style?');
    await page
      .getByRole('button', { name: 'Send message', exact: true })
      .click();
    await page
      .getByRole('status')
      .filter({ hasText: 'Your message has been received' })
      .waitFor();
    assert(jobs.some((j) => j.payload.template === 'contact-enquiry'));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: owner auth, notifications/read state, template edits, owner-only test, contact, PWA/service worker, axe 0`,
    );
    if (width === 1440) {
      for (const device of ['iPhone', 'iPad']) {
        const apple = await browser.newContext({
          storageState: await context.storageState(),
          userAgent: `Mozilla/5.0 (${device}; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1`,
        });
        const applePage = await apple.newPage();
        await applePage.goto(origin + '/admin/notifications');
        await applePage
          .getByRole('switch', {
            name: 'Push notifications on this device',
            exact: true,
          })
          .click();
        await applePage
          .locator('[data-push-status]')
          .filter({ hasText: 'Add to Home Screen' })
          .waitFor();
        await apple.close();
      }
      console.log(
        'PASS iPhone / iPad: Home Screen setup guidance before permission request',
      );
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
