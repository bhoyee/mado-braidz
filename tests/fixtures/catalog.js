import { readFileSync } from 'node:fs';
const images = JSON.parse(
  readFileSync(
    new URL('../../src/db/style-image-manifest.json', import.meta.url),
    'utf8',
  ),
);
import { seedData, catalogRows } from '../../src/db/seed-data.js';
import { publicSettings } from '../../src/db/public-defaults.js';
export function fixtureCatalog(overrides = {}) {
  const categories = [...new Set(seedData.styles.map((s) => s.category))].map(
    (slug, id) => ({
      id: id + 1,
      slug,
      name:
        slug === 'mens'
          ? 'Men’s Braids & Locs'
          : slug[0].toUpperCase() + slug.slice(1),
    }),
  );
  const data = {
    styles: catalogRows().map((s, i) => ({
      ...s,
      id: i + 1,
      variants: s.variants.map((v, j) => ({ ...v, id: (i + 1) * 100 + j + 1 })),
      photos: images.filter(
        (image) => (image.styleSlug || image.slug) === s.slug,
      ),
    })),
    categories,
    addons: seedData.addons.map((a, i) => ({ ...a, id: i + 1 })),
    gallery: [],
    settings: { ...publicSettings, ...seedData.settings },
  };
  return {
    async load() {
      return structuredClone(data);
    },
    async findAdmin() {
      return null;
    },
    ...overrides,
  };
}
