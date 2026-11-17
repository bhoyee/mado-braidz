// Creates and cancels a real sandbox combined Checkout; never takes payment.
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DateTime } from 'luxon';
import assert from 'node:assert/strict';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDatabase } from '../../src/db/index.js';
import { createBookingRepository } from '../../src/services/bookingRepository.js';
import { createBookingService } from '../../src/services/bookingService.js';
import {
  createPaymentService,
  createStripeProvider,
} from '../../src/services/paymentService.js';
import { parseEnv } from '../../src/config/env.js';
if (
  !process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') ||
  !process.env.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_')
)
  throw new Error('Sandbox test keys are required. Live keys are refused.');
const database = 'mado_batch_test_' + randomBytes(6).toString('hex');
const url = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
const admin = await mysql.createConnection(url.toString());
let pool, payments, batchId, provider, sessionId;
try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`);
  url.pathname = '/' + database;
  const created = createDatabase(url.toString());
  pool = created.pool;
  await migrate(created.db, { migrationsFolder: 'src/db/migrations' });
  execFileSync(process.execPath, ['scripts/seed.js'], {
    stdio: 'pipe',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      ADMIN_EMAIL: 'batch-test@example.test',
      ADMIN_PASSWORD: randomBytes(24).toString('hex'),
    },
  });
  const config = parseEnv({
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
    }),
    repo = createBookingRepository(created.db);
  provider = createStripeProvider(config);
  payments = createPaymentService(repo, provider, config);
  const bookings = createBookingService(repo, undefined, config.SESSION_SECRET);
  const catalog = await repo.catalog(),
    style = catalog.styles.find((s) => s.slug === 'knotless-braids'),
    variant = style.variants[0];
  const start = DateTime.now()
    .setZone('America/New_York')
    .plus({ days: 3 })
    .startOf('day')
    .set({ hour: 10 })
    .toUTC()
    .toISO();
  const holds = [];
  for (let i = 0; i < 2; i++)
    holds.push(
      await bookings.createHold({
        styleId: style.id,
        styleVariantId: variant.id,
        addonIds: [],
        paymentChoice: 'deposit',
        startAt: start,
        name: 'Sandbox Checkout Test',
        email: 'batch-test@example.test',
        phone: '+14437434979',
        policyAccepted: true,
        marketingConsent: false,
      }),
    );
  batchId = 'batch-' + randomBytes(16).toString('hex');
  const checkout = await payments.checkoutBatch(
    holds.map((h) => h.ref),
    Object.fromEntries(holds.map((h) => [h.ref, h.manageToken])),
    batchId,
  );
  sessionId = checkout.sessionId;
  const session = await provider.retrieveSession(sessionId);
  assert.equal(session.amount_total, 6000);
  assert.equal(session.currency, 'usd');
  assert.equal(session.metadata.batchId, batchId);
  await payments.cancelBatch(batchId);
  assert.equal((await provider.retrieveSession(sessionId)).status, 'expired');
  for (const hold of holds)
    assert.equal((await repo.bookingById(hold.id)).status, 'cancelled');
  console.log(
    'PASS: real Stripe sandbox combined checkout created for two $30 deposits, verified at $60, then expired. No payment taken.',
  );
} finally {
  // Expire only the session created by this test if later verification failed.
  if (sessionId && provider) {
    const session = await provider.retrieveSession(sessionId).catch(() => null);
    if (session?.status === 'open') await provider.expireSession(sessionId);
  }
  await pool?.end();
  if (/^mado_batch_test_[a-f0-9]{12}$/.test(database))
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.end();
}
