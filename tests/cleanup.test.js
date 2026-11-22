import { it, expect } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  utimes,
  access,
  rm,
} from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { cleanupUploads } from '../src/jobs/cleanupUploads.js';
it('preserves saved videos and cover sizes, including hidden videos', async () => {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/cleanup-test-'));
  try {
    await mkdir(join(root, 'catalog'));
    await mkdir(join(root, 'videos'));
    const kept = 'a'.repeat(36) + '.mp4',
      orphan = 'b'.repeat(36) + '.mp4',
      poster = 'c'.repeat(36) + '-1600.webp',
      small = 'c'.repeat(36) + '-480.webp';
    const old = new Date(Date.now() - 40 * 86400000);
    for (const [part, name] of [
      ['videos', kept],
      ['videos', orphan],
      ['catalog', poster],
      ['catalog', small],
    ]) {
      const file = join(root, part, name);
      await writeFile(file, 'test');
      await utimes(file, old, old);
    }
    expect(
      await cleanupUploads(root, [], [], new Date(), [
        {
          src: '/media/videos/' + kept,
          poster: '/media/catalog/' + poster,
          posterVariants: { sizes: [{ path: '/media/catalog/' + small }] },
          enabled: false,
        },
      ]),
    ).toBe(1);
    await expect(access(join(root, 'videos', orphan))).rejects.toThrow();
    for (const [part, name] of [
      ['videos', kept],
      ['catalog', poster],
      ['catalog', small],
    ])
      await expect(access(join(root, part, name))).resolves.toBeUndefined();
  } finally {
    if (resolve(root).startsWith(resolve('tmp/cleanup-test-')))
      await rm(root, { recursive: true });
  }
});
it('only removes old generated uploads without a database reference', async () => {
  await mkdir('tmp', { recursive: true });
  const root = await mkdtemp(resolve('tmp/cleanup-test-'));
  try {
    const kept = 'a'.repeat(40) + '.webp',
      orphan = 'b'.repeat(40) + '.webp',
      recent = 'c'.repeat(40) + '.webp';
    for (const name of [kept, orphan, recent, 'important.txt'])
      await writeFile(join(root, name), 'test');
    const old = new Date(Date.now() - 40 * 86400000);
    for (const name of [kept, orphan, 'important.txt'])
      await utimes(join(root, name), old, old);
    expect(await cleanupUploads(root, [{ path: kept }], [])).toBe(1);
    await expect(access(join(root, orphan))).rejects.toThrow();
    for (const name of [kept, recent, 'important.txt'])
      await expect(access(join(root, name))).resolves.toBeUndefined();
  } finally {
    if (resolve(root).startsWith(resolve('tmp/cleanup-test-')))
      await rm(root, { recursive: true });
  }
});
