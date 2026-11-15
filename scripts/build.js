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
