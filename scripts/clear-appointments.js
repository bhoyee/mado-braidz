// Server only. Without --confirm it changes nothing.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DateTime } from 'luxon';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import {
  clearAppointments,
  previewClear,
} from '../src/services/clearAppointments.js';

const usd = (cents) => '$' + (cents / 100).toFixed(2);
let pool;
try {
  const { values } = parseArgs({
    options: {
      confirm: { type: 'string' },
      'payments-settled': { type: 'boolean', default: false },
    },
  });
  const env = parseEnv();
  const database = createDatabase(env.DATABASE_URL);
  pool = database.pool;
  console.log(`Site: ${env.APP_URL}`);
  if (values.confirm === undefined) {
    const found = await previewClear(database.db);
    for (const row of found.bookings) {
      const time = DateTime.fromJSDate(row.startAt, {
        zone: 'America/New_York',
      }).toFormat('LLL d, yyyy h:mm a');
      const money =
        row.keptCents > 0
          ? `${usd(row.keptCents)} NOT REFUNDED${row.byCard ? ' (card)' : ''}`
          : 'nothing kept';
      console.log(
        `${row.ref} | ${time} ET | ${row.status} | ${row.client?.name || ''} <${row.client?.email || ''}> | ${money}`,
      );
    }
    console.log('\nWould be deleted:');
    for (const [name, count] of Object.entries(found.counts))
      console.log(`  ${count} ${name}`);
    console.log(
      `\nOpen card payments: ${found.open.checkouts}. Open refunds: ${found.open.refunds}. Not refunded: ${usd(found.keptCents)}.`,
    );
    console.log(
      `Nothing was changed. To delete, add: --confirm=${found.bookings.length}${found.keptCents ? ' --payments-settled' : ''}`,
    );
  } else {
    if (!/^\d+$/.test(values.confirm))
      throw new Error('Use --confirm= with the number from the preview.');
    const result = await clearAppointments(database.db, {
      confirm: Number(values.confirm),
      settled: values['payments-settled'],
      directory: join(homedir(), 'mado-backups', 'appointments'),
    });
    console.log(`Deleted ${result.bookings.length} appointments.`);
    console.log(`Private copy: ${result.file}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
