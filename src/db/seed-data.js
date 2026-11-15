import { readFile } from 'node:fs/promises';
export const seedData = JSON.parse(
  await readFile(new URL('./seed-data.json', import.meta.url), 'utf8'),
);
export function catalogRows(data = seedData) {
  return data.styles.map((style, sort) => ({
    ...style,
    sort,
    durationMin: 240,
    variants: (style.variants ?? []).map(
      ([size, length, priceCents], sort) => ({
        size,
        length,
        priceCents,
        sort,
      }),
    ),
  }));
}
