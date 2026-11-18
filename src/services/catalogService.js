import { eq, asc, and } from 'drizzle-orm';
import * as s from '../db/schema.js';
export function createCatalogService(db) {
  return {
    async load() {
      const [
        styles,
        variants,
        categories,
        addons,
        media,
        settings,
        redirects,
        links,
      ] = await Promise.all([
        db
          .select()
          .from(s.styles)
          .where(eq(s.styles.active, true))
          .orderBy(asc(s.styles.sort)),
        db
          .select()
          .from(s.styleVariants)
          .where(eq(s.styleVariants.active, true))
          .orderBy(asc(s.styleVariants.sort)),
        db
          .select()
          .from(s.styleCategories)
          .orderBy(asc(s.styleCategories.sort)),
        db
          .select()
          .from(s.addons)
          .where(eq(s.addons.active, true))
          .orderBy(asc(s.addons.sort)),
        db.select().from(s.media).orderBy(asc(s.media.sort)),
        db.select().from(s.settings),
        db.select().from(s.redirects),
        db.select().from(s.addonStyles),
      ]);
      return {
        styles: styles.map((style) => ({
          ...style,
          category: categories.find((c) => c.id === style.categoryId)?.slug,
          variants: variants.filter((v) => v.styleId === style.id),
          photos: media.filter(
            (m) => m.styleId === style.id && m.kind === 'style',
          ),
        })),
        categories,
        redirects,
        addons: addons.map((addon) => ({
          ...addon,
          styleIds: links
            .filter((link) => link.addonId === addon.id)
            .map((link) => link.styleId),
        })),
        gallery: media.filter((m) => m.kind === 'gallery'),
        settings: Object.fromEntries(
          settings.map((row) => [
            row.key,
            typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
          ]),
        ),
      };
    },
    async findAdmin(email) {
      const [admin] = await db
        .select()
        .from(s.admins)
        .where(and(eq(s.admins.email, email), eq(s.admins.role, 'owner')))
        .limit(1);
      return admin;
    },
  };
}
