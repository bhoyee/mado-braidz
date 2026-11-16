import './prepare-logo.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import ffmpeg from 'ffmpeg-static';
mkdirSync('public/media', { recursive: true });
// Source footage lives in docs/design/videos (not committed). Each clip is a
// short, silent, web-sized excerpt with a poster frame.
const clips = [
  {
    // Before and after: spring twists from the first section to the final smile.
    source: 'video3.mp4',
    name: 'transformation',
    start: 0,
    seconds: 20,
    filter: 'crop=464:736:0:48,scale=464:736',
    poster: 10,
  },
  {
    // The studio itself: the wood wall, the sign, arched mirrors and chairs.
    source: 'video4.mp4',
    name: 'studio-tour',
    start: 4,
    seconds: 14,
    filter: 'crop=478:780:0:30,scale=478:780',
    poster: 4.6,
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
    // At the chair: braiding a client in the purple cape.
    source: 'video2.mp4',
    name: 'at-the-chair',
    start: 34,
    seconds: 10,
    filter: 'crop=478:520:0:330,scale=478:520',
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
      String(clip.crf ?? 25),
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

// Montages: one or more shots joined with soft fades into a single silent
// clip (every shot must share the output size) plus a poster frame.
function buildMontage({ name, shots, fade = 0.5, poster, crf = 24 }) {
  const inputs = shots.flatMap((shot) => [
    '-ss',
    String(shot.start),
    '-t',
    String(shot.seconds),
    '-i',
    `docs/design/videos/${shot.source}`,
  ]);
  const graph = shots.map(
    (shot, i) =>
      `[${i}:v]fps=24,${shot.filter},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[s${i}]`,
  );
  let last = 's0';
  let elapsed = shots[0].seconds;
  for (let i = 1; i < shots.length; i++) {
    graph.push(
      `[${last}][s${i}]xfade=transition=fade:duration=${fade}:offset=${(elapsed - fade).toFixed(2)}[x${i}]`,
    );
    elapsed += shots[i].seconds - fade;
    last = `x${i}`;
  }
  const ff = (args) =>
    execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', ...args],
      {
        stdio: 'inherit',
      },
    );
  ff([
    ...inputs,
    '-filter_complex',
    graph.join(';'),
    '-map',
    `[${last}]`,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    `public/media/${name}.mp4`,
  ]);
  ff([
    '-ss',
    String(poster),
    '-i',
    `public/media/${name}.mp4`,
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-quality',
    '86',
    `public/media/${name}.webp`,
  ]);
  console.log(
    `Prepared ${name}: ${shots.length}-shot film, ${elapsed.toFixed(1)}s`,
  );
}

// Hero: video5 only — the knotless client smiling and swinging her braids in
// front of the Mado Braids sign at the studio, at full height.
buildMontage({
  name: 'studio-knotless',
  poster: 7,
  shots: [
    { source: 'video5.mp4', start: 43, seconds: 11, filter: 'scale=478:850' },
  ],
});

// Home studio section: the clean parts of the room only — hair supplies, arched
// mirrors and styling chairs. Skips the storage carts and the moments where the
// person filming is reflected in a mirror (about 17–21 s).
buildMontage({
  name: 'studio-space',
  poster: 2,
  crf: 25,
  shots: [
    { source: 'video4.mp4', start: 12, seconds: 4.5, filter: 'scale=478:850' },
    { source: 'video4.mp4', start: 22, seconds: 4.5, filter: 'scale=478:850' },
  ],
});
