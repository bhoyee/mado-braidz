import { spawnSync } from 'node:child_process';
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    'tests/booking.mysql.test.js',
    'tests/management.mysql.test.js',
  ],
  { stdio: 'inherit', env: { ...process.env, BOOKING_DATABASE_TEST: '1' } },
);
process.exit(result.status ?? 1);
