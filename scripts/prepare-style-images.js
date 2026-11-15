import sharp from 'sharp';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const sources = JSON.parse(
  await readFile('src/db/style-image-sources.json', 'utf8'),
);
await mkdir('public/img/styles', { recursive: true });
const manifest = [];
for (const item of sources) {
  const sizes = [];
  for (const width of [480, 960]) {
    const name = `${item.slug}-${width}.webp`;
    const info = await sharp(item.source)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toFile(`public/img/styles/${name}`);
    const avifName = `${item.slug}-${width}.avif`;
    await sharp(item.source)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .avif({ quality: 48, effort: 4 })
      .toFile(`public/img/styles/${avifName}`);
    sizes.push({
      avif: `/img/styles/${avifName}`,
      path: `/img/styles/${name}`,
      width: info.width,
      height: info.height,
    });
  }
  const main = sizes.at(-1);
  manifest.push({
    slug: item.slug,
    path: main.path,
    width: main.width,
    height: main.height,
    alt: item.alt,
    variants: { origin: item.origin, sizes },
  });
  console.log(`Prepared ${item.slug} (${item.origin})`);
}
await writeFile(
  'src/db/style-image-manifest.json',
  JSON.stringify(manifest, null, 2) + '\n',
);

const gallerySources = JSON.parse(
  await readFile('src/db/gallery-image-sources.json', 'utf8'),
);
await mkdir('public/img/gallery', { recursive: true });
const gallery = [];
for (const item of gallerySources) {
  const sizes = [];
  for (const width of [480, 960]) {
    const name = `${item.slug}-${width}.webp`;
    const info = await sharp(item.source)
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82, effort: 5 })
      .toFile(`public/img/gallery/${name}`);
    sizes.push({
      path: `/img/gallery/${name}`,
      width: info.width,
      height: info.height,
    });
  }
  const main = sizes.at(-1);
  gallery.push({
    slug: item.slug,
    path: main.path,
    width: main.width,
    height: main.height,
    alt: item.alt,
    variants: { origin: 'supplied', sizes },
  });
}
await writeFile(
  'src/db/gallery-image-manifest.json',
  JSON.stringify(gallery, null, 2) + '\n',
);
