import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('public/build', { recursive: true });
execFileSync(
  process.execPath,
  [
    'node_modules/@tailwindcss/cli/dist/index.mjs',
    '-i',
    'src/styles/app.css',
    '-o',
    'public/build/app.css',
    '--minify',
  ],
  { stdio: 'inherit' },
);
copyFileSync(
  'node_modules/@alpinejs/csp/dist/cdn.min.js',
  'public/build/alpine.js',
);

copyFileSync('src/client/site.js', 'public/build/site.js');
mkdirSync('public/fonts', { recursive: true });
for (const [source, target] of [
  // Fraunces with the SOFT axis: a warm, rounded display serif.
  ['fraunces/files/fraunces-latin-soft-normal.woff2', 'fraunces-latin.woff2'],
  [
    'fraunces/files/fraunces-latin-soft-italic.woff2',
    'fraunces-italic-latin.woff2',
  ],
  ['figtree/files/figtree-latin-wght-normal.woff2', 'figtree-latin.woff2'],
  ['fraunces/LICENSE', 'fraunces-LICENSE.txt'],
  ['figtree/LICENSE', 'figtree-LICENSE.txt'],
])
  copyFileSync(
    `node_modules/@fontsource-variable/${source}`,
    `public/fonts/${target}`,
  );

copyFileSync('src/client/booking.js', 'public/build/booking.js');

copyFileSync('src/client/payment.js', 'public/build/payment.js');
