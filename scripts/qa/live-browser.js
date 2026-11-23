// The overview refreshes silently without losing the owner's place.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

let rows = Array.from({ length: 30 }, (_, i) => 'Client ' + (i + 1)),
  signedOut = false,
  reviews = 'One review',
  requests = 0;
const row = (name, i) =>
  `<tr style="height:40px" data-search="${name.toLowerCase()} +1443555${1000 + i}"><td>${name}</td><td><a href="/admin/bookings/${i}">View</a></td></tr>`;
const page = () => `<!doctype html><p data-live-status>Live</p>
<input type="search" data-live-filter><p data-live-filter-status></p>
<div data-live="metrics"><strong>${rows.length}</strong></div>
<section data-live="appointments"><div class="owner-table-wrap" tabindex="0" style="height:200px;overflow:auto"><table><tbody>${rows.map(row).join('')}</tbody></table></div><button type="button" data-scroll-hint hidden>Scroll for more</button></section>
<div data-live="reviews" data-live-reload><p>${reviews}</p><textarea></textarea></div>
<script src="/live.js"></script>`;
const server = createServer((req, res) => {
  if (req.url === '/live.js')
    return res
      .writeHead(200, { 'content-type': 'text/javascript' })
      .end(readFileSync('src/client/admin-live.js'));
  if (req.url !== '/') return res.end('login');
  if (signedOut) return res.writeHead(303, { location: '/login' }).end();
  requests++;
  res
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end(page());
}).listen(0);
const browser = await chromium.launch({
  channel: process.env.QA_BROWSER || 'msedge',
});
try {
  const tab = await browser.newPage();
  await tab.clock.install();
  await tab.goto(`http://127.0.0.1:${server.address().port}/`);
  const tick = async () => {
    const reply = tab.waitForResponse((r) => r.status() === 200);
    await tab.clock.runFor(15100);
    await reply;
    await new Promise((done) => setTimeout(done, 200));
  };
  const wrap = tab.locator('.owner-table-wrap');
  await tab.locator('a[href="/admin/bookings/12"]').focus();
  await wrap.evaluate((el) => (el.scrollTop = 400));
  const top = await wrap.evaluate((el) => el.scrollTop);
  rows = [...rows, 'New client'];
  await tick();
  assert.equal(await tab.locator('[data-live=metrics]').innerText(), '31');
  assert.equal(await tab.locator('tr.row-fresh').count(), 1);
  assert.equal(await wrap.evaluate((el) => el.scrollTop), top);
  assert.equal(
    await tab.evaluate(() => document.activeElement.getAttribute('href')),
    '/admin/bookings/12',
  );
  assert.match(await tab.locator('[data-live-status]').innerText(), /updated/);

  // Unchanged data leaves the page alone.
  await wrap.evaluate((el) => (el.dataset.kept = 'yes'));
  await tick();
  assert.equal(await wrap.getAttribute('data-kept'), 'yes');

  // Selecting text is never interrupted.
  await tab.evaluate(() =>
    getSelection().selectAllChildren(document.querySelector('td')),
  );
  rows = [...rows, 'Another client'];
  await tick();
  assert.equal(await wrap.getAttribute('data-kept'), 'yes');
  await tab.evaluate(() => getSelection().removeAllRanges());
  await tick();
  assert.equal(await tab.locator('tbody tr').count(), 32);

  // Search filters instantly, by name or phone, and survives a refresh.
  const box = tab.locator('[data-live-filter]');
  await box.fill('another');
  assert.equal(await tab.locator('tbody tr:visible').count(), 1);
  rows = [...rows, 'Late client'];
  await tick();
  assert.equal(await tab.locator('tbody tr:visible').count(), 1);
  assert.equal(await box.inputValue(), 'another');
  await box.fill('(443) 555-1004');
  assert.equal(
    await tab.locator('tbody tr:visible').innerText(),
    'Client 5\tView',
  );
  await box.fill('client 4');
  assert.equal(await tab.locator('tbody tr:visible').count(), 1);
  await box.fill('nobody here');
  assert.equal(await tab.locator('tbody tr:visible').count(), 0);
  assert.match(
    await tab.locator('[data-live-filter-status]').innerText(),
    /No upcoming/,
  );
  await box.fill('');
  assert.equal(await tab.locator('tbody tr:visible').count(), 33);

  // The hint shows only while rows are hidden below.
  const hint = tab.locator('[data-scroll-hint]');
  assert.equal(await hint.isVisible(), true);
  await hint.click();
  await wrap.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await hint.waitFor({ state: 'hidden' });

  // A note being typed survives; the page reloads once it is cleared.
  await tab.locator('textarea').fill('Checking the bank');
  reviews = 'Two reviews';
  await tick();
  assert.equal(await tab.locator('textarea').inputValue(), 'Checking the bank');
  assert.equal(await tab.getByText('One review').count(), 1);
  await tab.locator('textarea').fill('');
  await tab.locator('textarea').blur();
  await tick();
  await tab.getByText('Two reviews').waitFor();

  // A signed-out session stops instead of repeating.
  signedOut = true;
  await tick();
  assert.match(
    await tab.locator('[data-live-status]').innerText(),
    /session ended/,
  );
  const before = requests;
  signedOut = false;
  await tab.clock.runFor(60000);
  assert.equal(requests, before);
  console.log('Live refresh browser checks passed');
} finally {
  await browser.close();
  server.close();
}
