import { describe, it, expect } from 'vitest';
import {
  dollars,
  blockOccurrences,
  availabilityInput,
  redirectInput,
} from '../src/services/managementValidation.js';
import { prepareCatalogImage } from '../src/services/catalogImages.js';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
describe('owner catalog validation and images', () => {
  it('stores exact integer cents and rejects exponent, negative or extra decimals', () => {
    expect(dollars.parse('219.99')).toBe(21999);
    for (const value of ['1e2', '-10', '10.009', 'Infinity'])
      expect(dollars.safeParse(value).success).toBe(false);
  });
  it('keeps weekly blocks at the same Eastern wall time across daylight saving', () => {
    const rows = blockOccurrences({
      date: '2026-10-25',
      start: '10:00',
      end: '12:00',
      reason: 'Away',
      repeat: 'weekly',
      until: '2026-11-08',
    });
    expect(rows.map((r) => r.startAt.toISOString())).toEqual([
      '2026-10-25T14:00:00.000Z',
      '2026-11-01T15:00:00.000Z',
      '2026-11-08T15:00:00.000Z',
    ]);
    expect(() =>
      blockOccurrences({
        date: '2026-03-08',
        start: '02:30',
        end: '04:00',
        repeat: 'once',
      }),
    ).toThrow();
  });
  it('rejects unsafe redirect destinations and private booking routes', () => {
    for (const target of [
      '//evil.test',
      'https://evil.test',
      '/booking/private',
      '/admin',
      '/api/bookings',
      '/styles/../admin',
      '/styles/%2e%2e',
    ])
      expect(
        redirectInput.safeParse({ source: '/old-style', target }).success,
      ).toBe(false);
  });
  it('fixes capacity at three and rejects overnight opening hours', () => {
    const raw = Object.fromEntries(
      [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ].flatMap((day) => [
        [day + 'Open', '06:00'],
        [day + 'Close', '21:00'],
      ]),
    );
    expect(
      availabilityInput({
        ...raw,
        bufferMinutes: 30,
        minNoticeHours: 24,
        maxAdvanceDays: 60,
      }).booking.capacity,
    ).toBe(3);
    expect(() =>
      availabilityInput({
        ...raw,
        mondayOpen: '22:00',
        bufferMinutes: 30,
        minNoticeHours: 24,
        maxAdvanceDays: 60,
      }),
    ).toThrow();
  });
  it('checks real image bytes, reencodes six responsive files and strips metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mado-photo-test-'));
    try {
      await expect(
        prepareCatalogImage(Buffer.from('<svg>bad</svg>'), root),
      ).rejects.toThrow();
      const input = await sharp({
        create: {
          width: 1800,
          height: 2200,
          channels: 3,
          background: '#884488',
        },
      })
        .jpeg()
        .toBuffer();
      const photo = await prepareCatalogImage(input, root);
      expect(photo.variants.sizes.map((r) => r.width)).toEqual([
        480, 960, 1600,
      ]);
      const files = await readdir(join(root, 'catalog'));
      expect(files).toHaveLength(6);
      const meta = await sharp(
        await readFile(
          join(
            root,
            'catalog',
            files.find((f) => f.endsWith('1600.webp')),
          ),
        ),
      ).metadata();
      expect(meta.exif).toBeUndefined();
      expect(meta.format).toBe('webp');
      await photo.cleanup();
      expect(await readdir(join(root, 'catalog'))).toEqual([]);
    } finally {
      if (resolve(root).startsWith(join(resolve(tmpdir()), 'mado-photo-test-')))
        await rm(root, { recursive: true });
    }
  }, 30000);
});
