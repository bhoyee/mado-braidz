import { migrate } from 'drizzle-orm/mysql2/migrator';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
const { db, pool } = createDatabase(parseEnv().DATABASE_URL);
try {
  await migrate(db, { migrationsFolder: 'src/db/migrations' });
  console.log('Migrations complete');
} finally {
  await pool.end();
}
