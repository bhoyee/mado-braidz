import { eq, asc, desc, and } from 'drizzle-orm';
import * as s from '../db/schema.js';
import { orderStyles } from './styleSummary.js';
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
          .orderBy(desc(s.styles.createdAt), desc(s.styles.id)),
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
          .orderBy(asc(s.addons.sort), asc(s.addons.id)),
        db.select().from(s.media).orderBy(asc(s.media.sort), asc(s.media.id)),
        db.select().from(s.settings),
        db.select().from(s.redirects),
        db.select().from(s.addonStyles),
      ]);
      const order = settings.find((row) => row.key === 'catalog')?.value;
      const styleOrder = (typeof order === 'string' ? JSON.parse(order) : order)
        ?.styleOrder;
      return {
        styles: orderStyles(styles, styleOrder).map((style) => ({
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
        gallery: media.filter(
          (m) =>
            m.kind === 'gallery' ||
            (m.kind === 'style' &&
              (typeof m.variants === 'string'
                ? JSON.parse(m.variants)
                : m.variants
              )?.showInWork === true),
        ),
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
