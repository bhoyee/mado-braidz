import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { buildSync } from 'esbuild';
import './build-emails.js';
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
copyFileSync('src/client/batch-payment.js', 'public/build/batch-payment.js');
copyFileSync('src/client/admin.js', 'public/build/admin.js');
copyFileSync('src/client/admin-live.js', 'public/build/admin-live.js');
copyFileSync('src/client/admin-guide.js', 'public/build/admin-guide.js');
copyFileSync('src/client/admin-styles.js', 'public/build/admin-styles.js');
copyFileSync('src/client/admin-search.js', 'public/build/admin-search.js');
copyFileSync('src/client/style-gallery.js', 'public/build/style-gallery.js');
copyFileSync('src/client/work.js', 'public/build/work.js');
copyFileSync('src/client/admin-settings.js', 'public/build/admin-settings.js');
copyFileSync('src/client/admin-clients.js', 'public/build/admin-clients.js');
copyFileSync('src/client/admin-gallery.js', 'public/build/admin-gallery.js');
copyFileSync('src/client/admin-videos.js', 'public/build/admin-videos.js');
buildSync({
  entryPoints: ['src/client/admin-calendar.js'],
  bundle: true,
  minify: true,
  outfile: 'public/build/admin-calendar.js',
  target: 'es2020',
});
writeFileSync(
  'public/build/admin-calendar-LICENSE.txt',
  [
    [
      'FullCalendar core and plugins',
      'node_modules/@fullcalendar/core/LICENSE.md',
    ],
    ['Preact', 'node_modules/preact/LICENSE'],
    ['Luxon', 'node_modules/luxon/LICENSE.md'],
  ]
    .map(([name, path]) => `${name}\n\n${readFileSync(path, 'utf8')}`)
    .join('\n\n'),
);
