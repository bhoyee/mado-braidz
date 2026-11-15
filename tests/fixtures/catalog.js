import { seedData, catalogRows } from '../../src/db/seed-data.js';
import { publicSettings } from '../../src/db/public-defaults.js';
export function fixtureCatalog(overrides = {}) {
  const categories = [...new Set(seedData.styles.map((s) => s.category))].map(
    (slug, id) => ({
      id: id + 1,
      slug,
      name: slug[0].toUpperCase() + slug.slice(1),
    }),
  );
  const data = {
    styles: catalogRows().map((s, i) => ({ ...s, id: i + 1, photos: [] })),
    categories,
    addons: seedData.addons,
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
