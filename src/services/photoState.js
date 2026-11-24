export const photoVariants = (photo) =>
  (typeof photo?.variants === 'string'
    ? JSON.parse(photo.variants)
    : photo?.variants) || {};
// A removed photo can be restored for a week before it is deleted for good.
export const KEEP_REMOVED_DAYS = 7;
export const isRemoved = (photo) => Boolean(photoVariants(photo).removedAt);
export const isShown = (photo) => {
  const variants = photoVariants(photo);
  return !variants.removedAt && !variants.hidden;
};
export const isReference = (photo) =>
  photoVariants(photo).origin === 'generated' ||
  /^AI hairstyle reference/i.test(photo.alt || '');

// Focus is kept to tenths so the website can use plain style classes.
export function cleanFocus(focus) {
  const tenth = (value) =>
    Math.min(100, Math.max(0, Math.round(Number(value) / 10) * 10));
  if (!focus || ![focus.x, focus.y].every((n) => Number.isFinite(Number(n))))
    return null;
  const clean = { x: tenth(focus.x), y: tenth(focus.y) };
  return clean.x === 50 && clean.y === 50 ? null : clean;
}
export function focusClass(photo) {
  const focus = cleanFocus(photoVariants(photo).focus);
  return focus ? `has-focus fx-${focus.x} fy-${focus.y}` : '';
}
// The owner's Our Work order. Anything not placed yet comes first, as today.
export function orderWork(items, order) {
  if (!Array.isArray(order) || !order.length) return items;
  const place = new Map(order.map((key, index) => [key, index]));
  return items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (place.get(a.item.key) ?? -1) - (place.get(b.item.key) ?? -1) ||
        a.index - b.index,
    )
    .map(({ item }) => item);
}
// What the library page shows for each photo. `workIds` comes from the public
// page itself, so the labels always match what clients see.
export function libraryPhoto(photo, { styles, media, workIds }) {
  const variants = photoVariants(photo);
  const style = styles.find((item) => item.id === photo.styleId) || null;
  const shown = isShown(photo);
  const siblings = media.filter(
    (item) =>
      item.styleId === photo.styleId && item.kind === 'style' && isShown(item),
  );
  const cover =
    siblings.find((item) => !photoVariants(item).size) || siblings[0];
  const onStyle = photo.kind === 'style' && shown;
  const inWork = shown && workIds.has(photo.id);
  const reference = isReference(photo);
  const sizes = variants.sizes || [];
  return {
    ...photo,
    variants,
    style,
    styleName: style?.name || 'Portfolio photo',
    thumb: sizes.find((size) => size.width >= 400)?.path || photo.path,
    removed: isRemoved(photo),
    hidden: !isRemoved(photo) && (variants.hidden || (!onStyle && !inWork)),
    onStyle,
    inWork,
    cover: Boolean(onStyle && cover?.id === photo.id),
    reference,
    focus: cleanFocus(variants.focus) || { x: 50, y: 50 },
    focusClass: focusClass(photo),
    issues: [
      reference ? 'Reference photo' : '',
      photo.styleId ? '' : 'No style chosen',
    ].filter(Boolean),
  };
}
