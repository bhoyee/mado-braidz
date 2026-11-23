// Development only: renders the committed 1200x630 social sharing card.
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const data = (file, type) =>
  `data:${type};base64,${readFileSync(file).toString('base64')}`;
const html = `<!doctype html><style>
@font-face{font-family:Fraunces;src:url(${data('public/fonts/fraunces-latin.woff2', 'font/woff2')});font-weight:100 900}
@font-face{font-family:Figtree;src:url(${data('public/fonts/figtree-latin.woff2', 'font/woff2')});font-weight:300 900}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;background:#fbf7f2;position:relative;overflow:hidden;font-family:Figtree;color:#1c0f26}
.copy{position:absolute;left:72px;top:44px;width:670px}
.logo{width:204px;height:204px;display:block;margin-left:-8px}
h1{font:600 64px/1.1 Fraunces;margin-top:36px;letter-spacing:-.015em}
p{font-size:31px;line-height:1.35;margin-top:22px;color:#5f2d9e;font-weight:600}
.url{position:absolute;left:0;bottom:0;width:100%;height:76px;background:#1c0f26;color:#fbf7f2;font-size:28px;font-weight:600;line-height:76px;padding-left:72px}
.photo{position:absolute;right:72px;top:44px;width:370px;height:542px;object-fit:cover;object-position:50% 18%;border-radius:185px 185px 0 0;z-index:1}
</style><div class="copy"><img class="logo" src="${data('public/img/logo.png', 'image/png')}">
<h1>African hair braiding in Lanham, MD</h1><p>Braids, twists and locs. Book online.</p></div>
<div class="url">madoafricanbraidz.com</div>
<img class="photo" src="${data('public/img/styles/boho-knotless-braids-960.webp', 'image/webp')}">`;
const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
  });
  await page.setContent(html);
  await page.evaluate('document.fonts.ready.then(() => true)');
  await page.screenshot({
    path: 'public/img/share-card.jpg',
    type: 'jpeg',
    quality: 86,
  });
} finally {
  await browser.close();
}
