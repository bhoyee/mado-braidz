import { it, expect } from 'vitest';
import { photoPlacement } from '../src/services/photoPlacement.js';
import { workItems } from '../src/routes/public/index.js';
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
