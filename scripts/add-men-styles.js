import { eq } from 'drizzle-orm';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { catalogRows } from '../src/db/seed-data.js';
import { styleCategories, styles, styleVariants } from '../src/db/schema.js';

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
  });
  console.log('Men’s styles ready; existing styles and prices preserved.');
} finally {
  await pool.end();
}
