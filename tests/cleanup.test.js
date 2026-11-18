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
