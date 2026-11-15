import { eq } from 'drizzle-orm';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { publicSettings } from '../src/db/public-defaults.js';
import { settings } from '../src/db/schema.js';
const { db, pool } = createDatabase(parseEnv().DATABASE_URL);
try {
  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({
        key: 'hours',
        value: publicSettings.hours,
        updatedAt: new Date(),
      })
      .onDuplicateKeyUpdate({
        set: { value: publicSettings.hours, updatedAt: new Date() },
      });
    const [existing] = await tx
      .select()
      .from(settings)
      .where(eq(settings.key, 'seo'));
    const seo =
      typeof existing?.value === 'string'
        ? JSON.parse(existing.value)
        : existing?.value || {};
    const value = {
      ...seo,
      pages: { ...seo.pages, about: publicSettings.seo.pages.about },
    };
    await tx
      .insert(settings)
      .values({ key: 'seo', value, updatedAt: new Date() })
      .onDuplicateKeyUpdate({ set: { value, updatedAt: new Date() } });
  });
  console.log(
    'Applied owner-confirmed daily 6am–6pm hours and supplied About copy; catalog prices unchanged',
  );
} finally {
  await pool.end();
}
