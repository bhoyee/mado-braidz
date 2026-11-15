import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import * as schema from './schema.js';
export function createDatabase(url) {
  const pool = mysql.createPool({
    uri: url,
    timezone: 'Z',
    connectionLimit: 5,
  });
  return { pool, db: drizzle(pool, { schema, mode: 'default' }) };
}
