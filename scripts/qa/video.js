import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const root = 'http://localhost:4780';
try {
  for (const preference of ['reduce', 'no-preference']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 1000 },
      reducedMotion: preference,
    });
    const page = await context.newPage();
    let downloads = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('.mp4')) downloads++;
    });
    await page.goto(root + '/');
    // Hero clips: autoplay, no controls, pause off screen, resume on return.
    await page.waitForTimeout(1100);
    if (preference === 'reduce' && downloads)
      throw new Error('Reduced-motion browsing auto-downloaded video');
    if (await page.locator('.hero button').count())
      throw new Error('Hero should have no video controls');
    if (preference === 'no-preference') {
      await page.waitForFunction(() => {
        const video = document.querySelector('[data-hero-video]');
        return !video.paused && video.currentTime > 0;
      });
      await page.locator('#styles-heading').scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForFunction(
        () => document.querySelector('[data-hero-video]').paused,
      );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForFunction(
        () => !document.querySelector('[data-hero-video]').paused,
      );
    }
    await page.goto(root + '/our-work');
    const count = downloads;
    await page.waitForTimeout(600);
    if (count !== downloads) throw new Error('Our Work eagerly loaded films');
    for (const film of await page.locator('[data-studio-player]').all()) {
      await film.scrollIntoViewIfNeeded();
      await film.locator('button').click();
      await page.waitForFunction(
        (id) => {
          const video = document.getElementById(id);
          return !video.paused && video.currentTime > 0;
        },
        await film.locator('video').getAttribute('id'),
      );
      await film.locator('button').click();
    }
    await context.close();
  }
  const saver = await browser.newContext();
  await saver.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  );
  const page = await saver.newPage();
  await page.goto(root + '/');
  await page.waitForTimeout(600);
  if (await page.locator('[data-hero-video] source').getAttribute('src'))
    throw new Error('Data saver loaded video');
  await saver.close();
  console.log(
    'PASS: hero autoplay without controls (pauses off screen, safeguards for reduced motion and data saver), request-only Our Work films and all clips',
  );
} finally {
  await browser.close();
}
