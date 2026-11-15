import { eq, and } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import * as s from '../src/db/schema.js';
export async function seedStyleImages(tx) {
  const styles = JSON.parse(
    await readFile(
      new URL('../src/db/style-image-manifest.json', import.meta.url),
      'utf8',
    ),
  );
  const gallery = JSON.parse(
    await readFile(
      new URL('../src/db/gallery-image-manifest.json', import.meta.url),
      'utf8',
    ),
  );
  for (const image of [
    ...styles.map((item) => ({ ...item, kind: 'style' })),
    ...gallery.map((item) => ({ ...item, kind: 'gallery' })),
  ]) {
    const [style] =
      image.kind === 'style'
        ? await tx.select().from(s.styles).where(eq(s.styles.slug, image.slug))
        : [];
    if (image.kind === 'style' && !style) continue;
    const [existing] = await tx
      .select()
      .from(s.media)
      .where(and(eq(s.media.kind, image.kind), eq(s.media.path, image.path)));
    if (existing)
      await tx
        .update(s.media)
        .set({ variants: image.variants })
        .where(eq(s.media.id, existing.id));
    if (!existing)
      await tx.insert(s.media).values({
        styleId: style?.id || null,
        kind: image.kind,
        path: image.path,
        variants: image.variants,
        width: image.width,
        height: image.height,
        alt: image.alt,
        sort: 100,
      });
  }
}
