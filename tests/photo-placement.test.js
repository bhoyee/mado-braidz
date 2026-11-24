import { it, expect } from 'vitest';
import { photoPlacement } from '../src/services/photoPlacement.js';
import { workItems } from '../src/routes/public/index.js';
import {
  cleanFocus,
  focusClass,
  isReference,
  isShown,
  libraryPhoto,
  orderWork,
} from '../src/services/photoState.js';
it('accepts one or both photo placements and rejects no placement', () => {
  expect(
    photoPlacement({
      placementFields: '1',
      showOnStyle: 'on',
      showInWork: 'on',
    }),
  ).toEqual({ kind: 'style', showInWork: true });
  expect(photoPlacement({ placementFields: '1', showOnStyle: 'on' })).toEqual({
    kind: 'style',
    showInWork: false,
  });
  expect(photoPlacement({ placementFields: '1', showInWork: 'on' })).toEqual({
    kind: 'gallery',
    showInWork: true,
  });
  expect(() => photoPlacement({ placementFields: '1' })).toThrow(
    'Choose where',
  );
  expect(photoPlacement({ kind: 'style' })).toEqual({ kind: 'style' });
});
it('shows a shared photo once in Our Work and respects style-only placement', () => {
  const photo = { path: '/img/shared.webp', variants: { showInWork: true } };
  expect(
    workItems([{ name: 'Braids', slug: 'braids', photo }], [photo], []),
  ).toHaveLength(1);
  expect(
    workItems(
      [
        {
          name: 'Braids',
          slug: 'braids',
          photo: { ...photo, variants: { showInWork: false } },
        },
      ],
      [],
      [],
    ),
  ).toHaveLength(0);
});

it('keeps the owner order of Our Work and puts new items first', () => {
  const items = ['a', 'b', 'c', 'new'].map((key) => ({ key }));
  expect(orderWork(items, ['c', 'a', 'b']).map((i) => i.key)).toEqual([
    'new',
    'c',
    'a',
    'b',
  ]);
  expect(orderWork(items, null)).toBe(items);
  const photo = (id) => ({ id, path: `/img/${id}.webp`, variants: {} });
  const order = ['photo:2', 'film:studio-knotless', 'photo:1'];
  const keys = workItems(
    [
      { name: 'One', slug: 'one', photo: photo(1) },
      { name: 'Two', slug: 'two', photo: photo(2) },
    ],
    [],
    [{ id: 'studio-knotless', enabled: true, showInWork: true }],
    order,
  ).map((item) => item.key);
  expect(keys).toEqual(order);
});
it('hides hidden and removed photos and turns focus into safe classes', () => {
  expect(isShown({ variants: { hidden: true } })).toBe(false);
  expect(isShown({ variants: JSON.stringify({ removedAt: 'x' }) })).toBe(false);
  expect(isShown({ variants: null })).toBe(true);
  expect(cleanFocus({ x: 23, y: 400 })).toEqual({ x: 20, y: 100 });
  expect(cleanFocus({ x: 50, y: 50 })).toBe(null);
  expect(cleanFocus({ x: '"><script>', y: 1 })).toBe(null);
  expect(focusClass({ variants: { focus: { x: 20, y: 0 } } })).toBe(
    'has-focus fx-20 fy-0',
  );
  expect(isReference({ alt: 'AI hairstyle reference: locs' })).toBe(true);
});
it('labels each library photo by what clients really see', () => {
  const styles = [{ id: 1, name: 'Braids', slug: 'braids' }];
  const cover = {
    id: 1,
    styleId: 1,
    kind: 'style',
    alt: 'Cover',
    variants: {},
  };
  const second = { ...cover, id: 2 };
  const hidden = { ...cover, id: 3, variants: { hidden: true } };
  const media = [hidden, cover, second];
  const label = (photo, workIds = new Set([1])) =>
    libraryPhoto({ path: '/x.webp', ...photo }, { styles, media, workIds });
  expect(label(cover)).toMatchObject({
    cover: true,
    inWork: true,
    hidden: false,
  });
  expect(label(second)).toMatchObject({
    cover: false,
    inWork: false,
    onStyle: true,
  });
  expect(label(hidden)).toMatchObject({
    cover: false,
    hidden: true,
    onStyle: false,
  });
});
