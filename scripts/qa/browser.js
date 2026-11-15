import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from '../../src/config/env.js';
const env = parseEnv();
const root = 'http://localhost:4780';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];
await mkdir('tmp/qa', { recursive: true });
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const failures = [];
    page.on('pageerror', (error) => failures.push(error.message));
    for (const path of [
      '/',
      '/styles',
      '/styles/knotless-braids',
      '/styles/knotless-braids?size=medium',
      '/styles/knotless-braids?size=semi_medium',
      '/styles/knotless-braids?size=small',
      '/our-work',
      '/about',
      '/contact',
      '/policies',
      '/privacy',
      '/terms',
      '/book',
      '/areas/bowie',
    ]) {
      const response = await page.goto(root + path);
      await page.evaluate(() => document.fonts.ready);
      if (!(await page.locator('h1').innerText()).trim())
        throw new Error(`Empty page heading at ${path}`);
      if ((await page.locator('body').innerText()).includes('NaN'))
        throw new Error(`Invalid price at ${path}`);
      const axe = await new AxeBuilder({ page })
        .withTags([
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
          'wcag22a',
          'wcag22aa',
        ])
        .analyze();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      const result = {
        path,
        width,
        status: response.status(),
        overflow,
        violations: axe.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
      };
      results.push(result);
      if (path === '/' || path === '/styles/knotless-braids') {
        for (const img of await page.locator('img').all())
          await img.scrollIntoViewIfNeeded();
        await page.evaluate(async () => {
          await Promise.all(
            [...document.images].map((img) => img.decode().catch(() => {})),
          );
          scrollTo({ top: 0, behavior: 'instant' });
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        });
        const broken = await page.evaluate(() =>
          [...document.images]
            .filter((img) => !img.naturalWidth)
            .map((img) => img.src),
        );
        if (broken.length)
          throw new Error('Broken images: ' + broken.join(', '));
        await page.screenshot({
          path: `tmp/qa/${path === '/' ? 'home' : 'style'}-${width}.png`,
          fullPage: true,
        });
      }
    }
    await page.goto(root + '/');
    await page.keyboard.press('Tab');
    if ((await page.locator(':focus').innerText()) !== 'Skip to content')
      throw new Error('Skip link is not first keyboard control');
    await page.keyboard.press('Enter');
    if ((await page.locator(':focus').getAttribute('id')) !== 'main')
      throw new Error('Skip link did not focus main');
    if (width === 390) {
      await page.locator('.mobile-nav summary').click();
      await page
        .getByRole('navigation', { name: 'Mobile navigation' })
        .getByRole('link', { name: 'Styles & Prices', exact: true })
        .click();
      if (!page.url().endsWith('/styles'))
        throw new Error('Mobile navigation failed');
    }
    await page.goto(root + '/styles?category=boho');
    if ((await page.locator('.style-card').count()) !== 2)
      throw new Error('Server category filter failed');
    await page.goto(root + '/styles/knotless-braids');
    await page.locator('.size-choice[href*="size=small"]').click();
    if ((await page.locator('.length-price').count()) !== 5)
      throw new Error('Small size lengths did not render');
    if (!(await page.locator('#lengths').innerText()).includes('$340'))
      throw new Error('Small price was incorrect');
    if (!page.url().includes('size=small#lengths'))
      throw new Error('Size selection was not preserved in URL');
    await page.goto(root + '/contact');
    if (await page.locator('iframe').count())
      throw new Error('Map loaded without consent');
    // Prevent external traffic while checking the click-to-load behavior.
    await page.route('https://maps.google.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<title>Map preview</title>',
      }),
    );
    await page.getByRole('button', { name: 'Load interactive map' }).click();
    if ((await page.locator('iframe').count()) !== 1)
      throw new Error('Map button failed');
    if (failures.length) throw new Error(failures.join('\n'));
    await context.close();
  }
  const context = await browser.newContext({
    httpCredentials: {
      username: env.ADMIN_EMAIL,
      password: env.ADMIN_PASSWORD,
    },
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(root + '/admin/design');
  if ((await page.locator('h1').count()) !== 1)
    throw new Error('Owner preview login failed');
  const axe = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
      'wcag22a',
      'wcag22aa',
    ])
    .analyze();
  results.push({
    path: '/admin/design',
    width: 390,
    violations: axe.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        summary: n.failureSummary,
      })),
    })),
  });
  await page.getByRole('button', { name: 'Open preview modal' }).click();
  if (!(await page.getByRole('dialog').isVisible()))
    throw new Error('Modal failed');
  await page.keyboard.press('Escape');
  if (await page.getByRole('dialog').isVisible())
    throw new Error('Escape did not close modal');
  await page.getByRole('button', { name: 'Open summary', exact: true }).click();
  if (!(await page.locator('#demo-summary').isVisible()))
    throw new Error('Summary failed');
  await page
    .getByRole('button', { name: 'Close summary', exact: true })
    .click();
  await page.getByRole('button', { name: 'Waist', exact: true }).click();
  if (
    (await page
      .getByRole('button', { name: 'Waist', exact: true })
      .getAttribute('aria-pressed')) !== 'true'
  )
    throw new Error('Length selector failed');
  await page.screenshot({ path: 'tmp/qa/design-mobile.png', fullPage: true });
  await context.close();
  await writeFile(
    'tmp/qa/accessibility.json',
    JSON.stringify(results, null, 2),
  );
  const failed = results.filter(
    (r) => r.status >= 400 || r.overflow || r.violations.length,
  );
  console.log(
    JSON.stringify(
      {
        pages: results.length,
        failures: failed,
        keyboard: 'passed',
        interactions: 'passed',
      },
      null,
      2,
    ),
  );
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
