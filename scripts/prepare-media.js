import './prepare-logo.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import ffmpeg from 'ffmpeg-static';
mkdirSync('public/media', { recursive: true });
const clips = [
  {
    source: 'video3.mp4',
    name: 'finished-look',
    start: 10,
    seconds: 12,
    filter: 'crop=464:640:0:120,scale=464:640',
    poster: 5.5,
  },
  {
    source: 'video1.mp4',
    name: 'braid-detail',
    start: 22,
    seconds: 10,
    filter: 'crop=478:500:0:350,scale=478:500',
    poster: 3,
  },
  {
    source: 'video2.mp4',
    name: 'at-the-chair',
    start: 34,
    seconds: 10,
    filter: 'crop=478:610:0:240,scale=478:610',
    poster: 5,
  },
];
for (const clip of clips) {
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(clip.start),
      '-i',
      `docs/design/videos/${clip.source}`,
      '-t',
      String(clip.seconds),
      '-vf',
      clip.filter,
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '25',
      '-pix_fmt',
      'yuv420p',
      '-r',
      '24',
      '-movflags',
      '+faststart',
      `public/media/${clip.name}.mp4`,
    ],
    { stdio: 'inherit' },
  );
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(clip.poster),
      '-i',
      `public/media/${clip.name}.mp4`,
      '-frames:v',
      '1',
      '-c:v',
      'libwebp',
      '-quality',
      '86',
      `public/media/${clip.name}.webp`,
    ],
    { stdio: 'inherit' },
  );
  console.log(`Prepared ${clip.name}: ${clip.seconds}s, silent MP4 and poster`);
}
