import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inspectVideo } from '../src/services/catalogVideos.js';
import { studioVideos } from '../src/services/studioVideos.js';
import { workItems } from '../src/routes/public/index.js';
const clip = readFileSync(
  new URL('../public/media/studio-knotless.mp4', import.meta.url),
);
describe('Short video validation', () => {
  it('reads the real studio MP4 dimensions and duration', () => {
    const info = inspectVideo(clip);
    expect(info.width).toBeGreaterThan(0);
    expect(info.height).toBeGreaterThan(0);
    expect(info.durationSec).toBeGreaterThan(0);
    expect(info.durationSec).toBeLessThanOrEqual(60);
  });
  it('rejects renamed HTML, oversized files and truncated containers', () => {
    for (const value of [
      Buffer.from('<html>not a video</html>'),
      Buffer.alloc(30 * 1024 * 1024 + 1),
      clip.subarray(0, clip.length - 100),
    ])
      expect(() => inspectVideo(value)).toThrow();
  });
  it('rejects unsupported codecs and overlong videos', () => {
    const codec = Buffer.from(clip),
      index = codec.indexOf('avc1', codec.indexOf('stsd'));
    expect(index).toBeGreaterThan(0);
    codec.write('hvc1', index);
    expect(() => inspectVideo(codec)).toThrow();
    const long = Buffer.from(clip),
      mvhd = long.indexOf('mvhd'),
      payload = mvhd + 4;
    expect(long[payload]).toBe(0);
    const scale = long.readUInt32BE(payload + 12);
    long.writeUInt32BE(scale * 61, payload + 16);
    expect(() => inspectVideo(long)).toThrow();
  });
});
describe('Managed studio videos', () => {
  it('includes all five existing clips without duplicating them', () => {
    expect(studioVideos()).toHaveLength(5);
    expect(workItems([], []).filter((v) => v.type === 'film')).toHaveLength(4);
  });
  it('removes hidden clips from Our Work and includes newly published uploads', () => {
    const videos = studioVideos({
      videos: {
        items: [
          { id: 'studio-knotless', enabled: false },
          {
            id: 'new-clip',
            title: 'A new look',
            src: '/media/videos/test.mp4',
            poster: '/media/catalog/test.webp',
            enabled: true,
            showInWork: true,
          },
        ],
      },
    });
    const items = workItems([], [], videos);
    expect(items.some((v) => v.name === 'studio-knotless')).toBe(false);
    expect(items.some((v) => v.name === 'new-clip')).toBe(true);
    expect(videos.find((v) => v.id === 'studio-knotless').locations).toContain(
      'Home hero',
    );
  });
});
