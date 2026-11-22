import { realpath, readdir, lstat, unlink } from 'node:fs/promises';
import { resolve, join, sep, basename } from 'node:path';
export async function cleanupUploads(
  directory,
  media,
  proofs,
  now = new Date(),
  videos = [],
) {
  if (!directory) return 0;
  const root = await realpath(resolve(directory)).catch(() => null);
  if (!root) return 0;
  const references = new Set();
  const remember = (value) => {
    if (typeof value !== 'string') return;
    if (value.startsWith('/media/catalog/'))
      references.add(join(root, 'catalog', basename(value)));
    else if (value.startsWith('/media/videos/'))
      references.add(join(root, 'videos', basename(value)));
    else if (!value.includes('/') && !value.includes('\\'))
      references.add(join(root, value));
  };
  for (const video of videos) remember(video.src);
  for (const row of [
    ...media,
    ...proofs,
    ...videos.map((v) => ({ path: v.poster, variants: v.posterVariants })),
  ]) {
    remember(row.path);
    const variants =
      typeof row.variants === 'string'
        ? JSON.parse(row.variants)
        : row.variants;
    for (const size of variants?.sizes || []) {
      remember(size.path);
      remember(size.avif);
    }
  }
  let removed = 0;
  for (const part of ['', 'catalog', 'videos']) {
    const folder = await realpath(join(root, part)).catch(() => null);
    if (!folder || (folder !== root && !folder.startsWith(root + sep)))
      continue;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const allowed =
        part === 'videos'
          ? /^[a-f0-9-]{36}\.mp4$/
          : part === 'catalog'
            ? /^[a-f0-9-]{36}-(480|960|1600)\.(webp|avif)$/
            : /^(?:[a-f0-9]{40}|payment-[a-f0-9]{48})\.webp$/;
      if (!allowed.test(entry.name)) continue;
      const file = resolve(folder, entry.name);
      if (!file.startsWith(root + sep) || references.has(file)) continue;
      const stat = await lstat(file);
      if (stat.isSymbolicLink() || stat.mtimeMs > +now - 30 * 86400000)
        continue;
      await unlink(file);
      removed++;
    }
  }
  return removed;
}
