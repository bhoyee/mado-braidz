import { parseArgs } from 'node:util';
import { z } from 'zod';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { addOwner } from '../src/services/adminAccounts.js';

const usage =
  'Usage: npm run admin:add -- --email=person@example.com --name="Person Name"';
let pool;
try {
  const { values } = parseArgs({
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
  if (!values.email || !values.name) throw new Error(usage);
  const env = parseEnv();
  const database = createDatabase(env.DATABASE_URL);
  pool = database.pool;
  const result = await addOwner(database.db, values);
  console.log(
    result.created
      ? `Owner added: ${result.email}`
      : `Already an owner, nothing changed: ${result.email}`,
  );
  if (result.created)
    console.log(
      `They set their password at ${env.APP_URL.replace(/\/$/, '')}/admin/forgot`,
    );
} catch (error) {
  console.error(
    error instanceof z.ZodError
      ? error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n')
      : error.message,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
