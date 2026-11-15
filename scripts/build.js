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
  ['fraunces/files/fraunces-latin-wght-normal.woff2', 'fraunces-latin.woff2'],
  [
    'fraunces/files/fraunces-latin-wght-italic.woff2',
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
