import ffmpeg from 'ffmpeg-static';
import { execFileSync } from 'node:child_process';
execFileSync(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    'docs/design/logo.png',
    '-vf',
    'scale=144:144',
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-quality',
    '90',
    'public/img/logo.webp',
  ],
  { stdio: 'inherit' },
);
