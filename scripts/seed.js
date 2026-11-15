import { seedStyleImages } from './seed-style-images.js';
import { publicSettings } from '../src/db/public-defaults.js';
import { eq, and, isNull } from 'drizzle-orm';
import argon2 from 'argon2';
import { z } from 'zod';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { seedData, catalogRows } from '../src/db/seed-data.js';
import * as s from '../src/db/schema.js';
const env = parseEnv();
const owner = z
  .object({ ADMIN_EMAIL: z.email(), ADMIN_PASSWORD: z.string().min(12) })
  .parse(env);
const hash = await argon2.hash(owner.ADMIN_PASSWORD, { type: argon2.argon2id });
const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(s.admins)
      .where(eq(s.admins.email, owner.ADMIN_EMAIL));
    if (process.argv.includes('--update-owner')) {
      const owners = await tx
        .select()
        .from(s.admins)
        .where(eq(s.admins.role, 'owner'));
      if (owners.length !== 1)
        throw new Error('Owner update requires exactly one existing owner');
      await tx
        .update(s.admins)
        .set({ email: owner.ADMIN_EMAIL, passwordHash: hash })
        .where(eq(s.admins.id, owners[0].id));
    } else if (!existing.length)
      await tx.insert(s.admins).values({
        email: owner.ADMIN_EMAIL,
        name: 'Mado',
        role: 'owner',
        passwordHash: hash,
        createdAt: new Date(),
      });
    const categories = [
      ...new Set(seedData.styles.map((style) => style.category)),
    ];
    for (const [sort, slug] of categories.entries())
      await tx
        .insert(s.styleCategories)
        .values({ slug, name: slug[0].toUpperCase() + slug.slice(1), sort })
        .onDuplicateKeyUpdate({ set: { slug } });
    for (const style of catalogRows()) {
      const [category] = await tx
        .select()
        .from(s.styleCategories)
        .where(eq(s.styleCategories.slug, style.category));
      await tx
        .insert(s.styles)
        .values({
          categoryId: category.id,
          name: style.name,
          slug: style.slug,
          durationMin: 240,
          priceOnConsultation: style.priceOnConsultation ?? false,
          fromPriceCents: style.fromPriceCents,
          featured: style.featured ?? false,
          shortDesc: style.note,
          sort: style.sort,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .onDuplicateKeyUpdate({ set: { slug: style.slug } });
      const [saved] = await tx
        .select()
        .from(s.styles)
        .where(eq(s.styles.slug, style.slug));
      for (const variant of style.variants) {
        const found = await tx
          .select()
          .from(s.styleVariants)
          .where(
            and(
              eq(s.styleVariants.styleId, saved.id),
              eq(s.styleVariants.size, variant.size),
              variant.length === null
                ? isNull(s.styleVariants.length)
                : eq(s.styleVariants.length, variant.length),
            ),
          );
        if (!found.length)
          await tx
            .insert(s.styleVariants)
            .values({ ...variant, styleId: saved.id });
      }
    }
    await seedStyleImages(tx);
    for (const addon of seedData.addons)
      await tx
        .insert(s.addons)
        .values(addon)
        .onDuplicateKeyUpdate({ set: { slug: addon.slug } });
    for (const [key, value] of Object.entries({
      ...publicSettings,
      ...seedData.settings,
    }))
      await tx
        .insert(s.settings)
        .values({ key, value, updatedAt: new Date() })
        .onDuplicateKeyUpdate({ set: { key } });
  });
  console.log(
    process.argv.includes('--update-owner')
      ? 'Seed complete (owner credentials updated; existing catalog and settings preserved)'
      : 'Seed complete (existing catalog, settings, and passwords preserved)',
  );
} finally {
  await pool.end();
}
