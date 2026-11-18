import { eq, and } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { catalogRows } from '../src/db/seed-data.js';
import {
  styleCategories,
  styles,
  styleVariants,
  media,
  settings,
} from '../src/db/schema.js';

// Add only these owner-approved services. Never reset existing salon content.
const { db, pool } = createDatabase(parseEnv().DATABASE_URL);
try {
  await db.transaction(async (tx) => {
    await tx
      .insert(styleCategories)
      .values({ name: 'Men’s Braids & Locs', slug: 'mens', sort: 90 })
      .onDuplicateKeyUpdate({ set: { slug: 'mens' } });
    const [category] = await tx
      .select()
      .from(styleCategories)
      .where(eq(styleCategories.slug, 'mens'));
    for (const style of catalogRows().filter(
      (item) => item.category === 'mens',
    )) {
      const [existing] = await tx
        .select()
        .from(styles)
        .where(eq(styles.slug, style.slug));
      if (existing) continue;
      const [result] = await tx.insert(styles).values({
        categoryId: category.id,
        name: style.name,
        slug: style.slug,
        shortDesc: style.note,
        durationMin: 240,
        sort: style.sort,
        updatedAt: new Date(),
      });
      await tx.insert(styleVariants).values(
        style.variants.map((variant) => ({
          ...variant,
          styleId: result.insertId,
          label: 'Standard service',
        })),
      );
    }
    // One-time photo import: later owner replacements/removals survive deploys.
    const marker = 'mens_photos_imported_v1';
    const [imported] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, marker));
    if (!imported) {
      const images = JSON.parse(
        await readFile(
          new URL('../src/db/style-image-manifest.json', import.meta.url),
          'utf8',
        ),
      );
      for (const slug of ['mens-invisible-locs', 'freestyle-stitch-cornrows']) {
        const image = images.find((item) => item.styleSlug === slug);
        const [style] = await tx
          .select()
          .from(styles)
          .where(eq(styles.slug, slug));
        const [existingPhoto] = await tx
          .select()
          .from(media)
          .where(and(eq(media.styleId, style.id), eq(media.kind, 'style')));
        if (image && !existingPhoto)
          await tx.insert(media).values({
            styleId: style.id,
            kind: 'style',
            path: image.path,
            variants: image.variants,
            width: image.width,
            height: image.height,
            alt: image.alt,
            sort: 100,
          });
      }
      await tx
        .insert(settings)
        .values({ key: marker, value: true, updatedAt: new Date() });
    }
  });
  console.log('Men’s styles ready; existing styles and prices preserved.');
} finally {
  await pool.end();
}
