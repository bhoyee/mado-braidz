import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const root = 'http://localhost:4780';
try {
  for (const preference of ['reduce', 'no-preference']) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      reducedMotion: preference,
    });
    const page = await context.newPage();
    let downloads = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('.mp4')) downloads++;
    });
    await page.goto(root + '/');
    await page.waitForTimeout(1000);
    if (downloads) throw new Error('Video downloaded before request');
    const player = page.locator('[data-studio-player]').first();
    await player.scrollIntoViewIfNeeded();
    const button = player.locator('button');
    await button.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-studio-video]');
      return !video.paused && video.currentTime > 0;
    });
    if (!(await button.innerText()).includes('Pause film'))
      throw new Error('Playback state not announced');
    await page.keyboard.press('Enter');
    if (!(await player.locator('video').evaluate((v) => v.paused)))
      throw new Error('Keyboard pause failed');
    await page.locator('h1').scrollIntoViewIfNeeded();
    await player.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    if (!(await player.locator('video').evaluate((v) => v.paused)))
      throw new Error('Manual pause was not preserved');
    await page.goto(root + '/gallery');
    const count = downloads;
    await page.waitForTimeout(600);
    if (count !== downloads) throw new Error('Gallery eagerly loaded films');
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
  if (await page.locator('video source').getAttribute('src'))
    throw new Error('Data saver loaded video');
  await saver.close();
  console.log(
    'PASS: request-only films, reduced-motion and data-saver browsing, all three clips, keyboard play/pause, and pause persistence',
  );
} finally {
  await browser.close();
}
