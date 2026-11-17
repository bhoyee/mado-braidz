import { eq } from 'drizzle-orm';
import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { publicSettings } from '../src/db/public-defaults.js';
import { seedData } from '../src/db/seed-data.js';
import { settings, addons } from '../src/db/schema.js';
const { db, pool } = createDatabase(parseEnv().DATABASE_URL);
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value || {};
try {
  await db.transaction(async (tx) => {
    async function current(key) {
      const [row] = await tx
        .select()
        .from(settings)
        .where(eq(settings.key, key));
      return decode(row?.value);
    }
    async function save(key, value) {
      await tx
        .insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onDuplicateKeyUpdate({ set: { value, updatedAt: new Date() } });
    }
    await save('hours', publicSettings.hours);
    await save('booking', {
      ...seedData.settings.booking,
      ...(await current('booking')),
      capacity: 3,
      stepMinutes: 30,
    });
    await save('policy', {
      ...(await current('policy')),
      hairIncluded: true,
      includedHumanHairPercent: 50,
      humanHairUpgradeSlug: 'human-hair-upgrade',
      hairDescription: publicSettings.policy.hairDescription,
    });
    const seo = await current('seo');
    const hairFaq = publicSettings.seo.pages.faq.find(
      (item) => item.question === 'Do I need to bring my own hair?',
    );
    const faq = [...(seo.pages?.faq || publicSettings.seo.pages.faq)];
    const index = faq.findIndex((item) => item.question === hairFaq.question);
    if (index === -1) faq.push(hairFaq);
    else faq[index] = hairFaq;
    // Update only the old rollout placeholder; preserve an owner's rewritten FAQ.
    const depositFaq = publicSettings.seo.pages.faq.find(
      (item) => item.question === 'How does the deposit work?',
    );
    const depositIndex = faq.findIndex(
      (item) => item.question === depositFaq.question,
    );
    if (depositIndex === -1) faq.push(depositFaq);
    else if (
      faq[depositIndex].answer.includes('Online checkout is coming soon')
    )
      faq[depositIndex] = depositFaq;
    await save('seo', {
      ...seo,
      pages: { ...seo.pages, about: publicSettings.seo.pages.about, faq },
    });
    const upgrade = seedData.addons.find(
      (addon) => addon.slug === 'human-hair-upgrade',
    );
    await tx
      .insert(addons)
      .values(upgrade)
      .onDuplicateKeyUpdate({ set: { ...upgrade, active: true } });
  });
  console.log(
    'Applied owner-confirmed hours, capacity 3, 30-minute starts, included hair and $40 upgrade; style prices preserved',
  );
} finally {
  await pool.end();
}
