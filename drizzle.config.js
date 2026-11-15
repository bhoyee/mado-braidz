import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  schema: './src/db/schema.js',
  out: './src/db/migrations',
  dialect: 'mysql',
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
});
