// Prepares the braid length guide (docs/design/Braids-Length-Guide.png, kept
// out of the web root) as responsive AVIF/WebP for the style detail pages.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';

const source = 'docs/design/Braids-Length-Guide.png';
const outDir = 'public/img/guides';
mkdirSync(outDir, { recursive: true });
for (const width of [600, 1100]) {
  const image = sharp(source).resize({ width, withoutEnlargement: true });
  await image
    .clone()
    .webp({ quality: 82 })
    .toFile(`${outDir}/braid-length-guide-${width}.webp`);
  await image
    .clone()
    .avif({ quality: 55 })
    .toFile(`${outDir}/braid-length-guide-${width}.avif`);
  console.log(`Prepared braid-length-guide-${width} (webp, avif)`);
}
