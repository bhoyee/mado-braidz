import { optionLabel } from './adminAppointment.js';

export const SIZES = [null, 'medium', 'semi_medium', 'small'];
export const LENGTHS = [
  null,
  'shoulder',
  'mid_back',
  'waist',
  'top_butt',
  'butt',
  'under_butt',
];
const name = (value, fallback) => (value ? optionLabel([value]) : fallback);
export const sizeNames = SIZES.map((value) => ({
  value: value || '',
  label: name(value, 'One size'),
}));
export const lengthNames = LENGTHS.map((value) => ({
  value: value || '',
  label: name(value, 'One length'),
}));
export const priceSort = (size, length) =>
  SIZES.indexOf(size) * 10 + LENGTHS.indexOf(length);
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;

// The owner's chosen order. Styles not placed yet stay first, newest first, so
// nothing moves on the website until an order is saved.
export function orderStyles(styles, order) {
  if (!Array.isArray(order) || !order.length) return styles;
  const place = new Map(order.map((id, index) => [id, index]));
  return styles
    .map((style, index) => ({ style, index }))
    .sort(
      (a, b) =>
        (place.get(a.style.id) ?? -1) - (place.get(b.style.id) ?? -1) ||
        a.index - b.index,
    )
    .map(({ style }) => style);
}
export function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return [
    hours ? `${hours} ${hours === 1 ? 'hr' : 'hrs'}` : '',
    rest ? `${rest} min` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
// Half-hour steps plus whatever is already saved.
export function durationChoices(...current) {
  const values = new Set(current.filter(Boolean));
  for (let minutes = 30; minutes <= 900; minutes += 30) values.add(minutes);
  return [...values]
    .sort((a, b) => a - b)
    .map((value) => ({ value, label: durationLabel(value) }));
}
export function styleSummary(style, { variants, media, categories }) {
  const prices = variants
    .filter((v) => v.styleId === style.id && v.active)
    .map((v) => v.priceCents);
  const photos = media.filter(
    (m) => m.styleId === style.id && m.kind === 'style',
  );
  const photo =
    photos.find((p) => !decode(p.variants)?.size) || photos[0] || null;
  const issues = [
    photo ? '' : 'No photo',
    style.priceOnConsultation || prices.length ? '' : 'No price',
    style.shortDesc?.trim() ? '' : 'No introduction',
  ].filter(Boolean);
  return {
    ...style,
    category: categories.find((c) => c.id === style.categoryId)?.name || '',
    photo,
    low: prices.length ? Math.min(...prices) : null,
    high: prices.length ? Math.max(...prices) : null,
    optionCount: prices.length,
    duration: durationLabel(style.durationMin),
    issues,
  };
}
// Every size and length, with the saved price where there is one.
export function priceGrid(variants) {
  return lengthNames.map((length) => ({
    ...length,
    cells: sizeNames.map((size) => ({
      size,
      variant:
        variants.find(
          (v) =>
            (v.size || '') === size.value && (v.length || '') === length.value,
        ) || null,
    })),
  }));
}
export function priceChanges(rows, variants) {
  return rows
    .map((row) => {
      const before = decode(row.before),
        after = decode(row.after) || {};
      const variant = variants.find((v) => v.id === row.entityId) || after;
      return {
        at: row.at,
        name: row.name,
        option: optionLabel([variant.size, variant.length]),
        from: before?.priceCents ?? null,
        to: after.priceCents ?? null,
        switched:
          before && Boolean(before.active) !== Boolean(after.active)
            ? after.active
              ? 'switched on'
              : 'switched off'
            : '',
      };
    })
    .filter((row) => row.from !== row.to || row.switched);
}
