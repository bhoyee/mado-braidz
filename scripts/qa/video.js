import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const root = 'http://localhost:4780';
try {
  const reduced = await browser.newContext({
    viewport: { width: 390, height: 900 },
    reducedMotion: 'reduce',
  });
  const page = await reduced.newPage();
  const downloads = [];
  page.on('request', (request) => {
    if (request.url().endsWith('.mp4')) downloads.push(request.url());
  });
  await page.goto(root + '/');
  await page.waitForTimeout(1100);
  if (downloads.length)
    throw new Error('Reduced-motion browsing downloaded video automatically');
  await page.locator('.hero-video').scrollIntoViewIfNeeded();
  const hero = page.locator('[data-hero-video]');
  if (!(await hero.evaluate((v) => v.paused)))
    throw new Error('Reduced-motion film played automatically');
  const toggle = page.locator('.hero-video [data-video-toggle]');
  await toggle.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => {
    const video = document.querySelector('[data-hero-video]');
    return !video.paused && video.currentTime > 0;
  });
  if (!(await toggle.innerText()).includes('Pause film'))
    throw new Error('Playback control did not update');
  await page.keyboard.press('Enter');
  if (!(await hero.evaluate((v) => v.paused)))
    throw new Error('Keyboard pause failed');
  await page.goto(root + '/gallery');
  const before = downloads.length;
  await page.waitForTimeout(1000);
  if (downloads.length !== before)
    throw new Error('Gallery loaded video without user request');
  for (const player of await page.locator('[data-studio-player]').all()) {
    await player.scrollIntoViewIfNeeded();
    await player.locator('button').click();
    await page.waitForFunction(
      (id) => !document.getElementById(id).paused,
      await player.locator('video').getAttribute('id'),
    );
    await player.locator('button').click();
  }
  await reduced.close();
  const standard = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'no-preference',
  });
  const active = await standard.newPage();
  await active.goto(root + '/');
  await active.waitForFunction(() => {
    const v = document.querySelector('[data-hero-video]');
    return !v.paused && v.currentTime > 0;
  });
  await active.locator('.hero-video button').click();
  await active.locator('#the-edit').scrollIntoViewIfNeeded();
  await active.locator('.hero-video').scrollIntoViewIfNeeded();
  await active.waitForTimeout(800);
  if (!(await active.locator('[data-hero-video]').evaluate((v) => v.paused)))
    throw new Error('A manually paused film resumed');
  await standard.close();
  const saver = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'no-preference',
  });
  await saver.addInitScript(() =>
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    }),
  );
  const saved = await saver.newPage();
  await saved.goto(root + '/');
  await saved.waitForTimeout(1000);
  if (await saved.locator('[data-hero-video] source').getAttribute('src'))
    throw new Error('Data saver loaded video automatically');
  await saver.close();
  console.log(
    'PASS: deferred gallery loading, reduced motion, data saver, autoplay, manual/keyboard playback, pause persistence, and all three clips',
  );
} finally {
  await browser.close();
}
