import { ManagementError } from './managementErrors.js';
import sharp from 'sharp';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export async function prepareCatalogImage(buffer, uploadDir) {
  if (!buffer?.length || buffer.length > 8 * 1024 * 1024)
    throw new ManagementError('Choose an image under 8 MB');
  const image = sharp(buffer, { limitInputPixels: 40000000, animated: false });
  const meta = await image.metadata().catch(() => {
    throw new ManagementError('Choose a valid JPEG, PNG, WebP or AVIF photo');
  });
  if (
    !['jpeg', 'png', 'webp', 'avif', 'heif'].includes(meta.format) ||
    (meta.pages || 1) > 1
  )
    throw new ManagementError('Choose a JPEG, PNG, WebP or AVIF photo');
  const directory = join(uploadDir, 'catalog'),
    key = randomUUID(),
    files = [],
    sizes = [];
  await mkdir(directory, { recursive: true });
  try {
    for (const width of [480, 960, 1600]) {
      const root = key + '-' + width;
      const webp = await image
        .clone()
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      const avif = await image
        .clone()
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .avif({ quality: 54, effort: 4 })
        .toBuffer();
      for (const [name, data] of [
        [root + '.webp', webp.data],
        [root + '.avif', avif],
      ]) {
        const file = join(directory, name);
        await writeFile(file, data, { flag: 'wx' });
        files.push(file);
      }
      sizes.push({
        path: '/media/catalog/' + root + '.webp',
        avif: '/media/catalog/' + root + '.avif',
        width: webp.info.width,
        height: webp.info.height,
      });
    }
    const main = sizes.at(-1);
    return {
      path: main.path,
      width: main.width,
      height: main.height,
      variants: { origin: 'supplied', sizes },
      cleanup: () =>
        Promise.all(files.map((file) => unlink(file).catch(() => {}))),
    };
  } catch (error) {
    await Promise.all(files.map((file) => unlink(file).catch(() => {})));
    throw error;
  }
}
