import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import {
  SAMPLE,
  guideFor,
  guideVideos,
  youtubeId,
} from '../src/config/guideVideos.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig } from './fixtures/stripe.js';

describe('owner guide videos', () => {
  it.each([
    'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com/watch?v=M7lc1UVf-VE&t=30s',
    'https://m.youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtu.be/M7lc1UVf-VE?si=share',
    'https://www.youtube.com/shorts/M7lc1UVf-VE',
    'https://www.youtube.com/live/M7lc1UVf-VE',
    'https://www.youtube.com/embed/M7lc1UVf-VE',
  ])('reads %s', (link) => expect(youtubeId(link)).toBe('M7lc1UVf-VE'));
  it.each([
    '',
    'not a link',
    'http://www.youtube.com/watch?v=M7lc1UVf-VE',
    'https://youtube.com.evil.example/watch?v=M7lc1UVf-VE',
    'https://evil.example/watch?v=M7lc1UVf-VE',
    'https://www.youtube.com/watch?v="><script>',
    'javascript:alert(1)',
  ])('rejects %s', (link) => expect(youtubeId(link)).toBeNull());
  it.each([
    ['/', 'Overview'],
    ['/bookings', 'Appointments'],
    ['/bookings/', 'Appointments'],
    ['/bookings/new', 'New appointment'],
    ['/bookings/12', 'Appointment details'],
    ['/bookings/12/edit', 'Edit an appointment'],
    ['/styles/new', 'Edit a style'],
    ['/settings', 'Studio details'],
  ])('%s shows the %s guide', (path, title) =>
    expect(guideFor(path, undefined, false).title).toBe(title),
  );
  it('separates the security tab and ignores unknown pages', () => {
    expect(guideFor('/settings', 'security', false).title).toBe(
      'Sign-in & security',
    );
    expect(guideFor('/nowhere', undefined, false)).toBeNull();
  });
  it('never shows a sample on the live site, but shows a real video', () => {
    for (const { path } of guideVideos.filter((g) => g.video === SAMPLE))
      expect(
        guideFor(path.split('?')[0].replace('*', '1'), undefined, true),
      ).toBeNull();
    const real = [
      { path: '/', title: 'Overview', video: 'https://youtu.be/abcdefghijk' },
    ];
    expect(guideFor('/', undefined, true, real)).toEqual({
      id: 'abcdefghijk',
      title: 'Overview',
    });
  });
  it('allows the YouTube player in the admin area only', async () => {
    const app = createApp({
      config: parseEnv(paymentConfig),
      catalog: fixtureCatalog(),
    });
    const csp = async (path) =>
      (await request(app).get(path)).headers['content-security-policy'];
    expect(await csp('/admin/login')).toContain(
      'https://www.youtube-nocookie.com',
    );
    expect(await csp('/')).not.toContain('youtube');
  });
});
