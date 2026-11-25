import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import * as s from '../db/schema.js';

// Everything an appointment leaves behind. Children come before their parents.
const TABLES = [
  ['payment screenshots', 'paymentProofs'],
  ['checkout attempts', 'checkoutAttempts'],
  ['payment batches', 'paymentBatches'],
  ['payments', 'payments'],
  ['booking extras', 'bookingAddons'],
  ['email log entries', 'emailLog'],
  ['alerts', 'notifications'],
  ['bookings', 'bookings'],
  ['clients', 'clients'],
];
const JOBS = [
  'email',
  'reminder',
  'winback',
  'push',
  'whatsapp',
  'refundConflict',
  'notification-marker',
  'webhook-failure',
];
// Messages that have nothing to do with an appointment stay.
const KEEP_TEMPLATES = ['password-reset', 'contact-enquiry', 'owner-test'];
const AUDIT = ['booking', 'client', 'payment_proof'];
const SETTINGS = ['clientLinks', 'clientTags'];
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;

async function collect(db) {
  const rows = {};
  for (const [, table] of TABLES)
    rows[table] = await db.select().from(s[table]);
  rows.jobs = (
    await db.select().from(s.jobs).where(inArray(s.jobs.type, JOBS))
  ).filter((job) => !KEEP_TEMPLATES.includes(decode(job.payload)?.template));
  rows.inspiration = await db
    .select()
    .from(s.media)
    .where(eq(s.media.kind, 'inspiration'));
  rows.auditLog = await db
    .select()
    .from(s.auditLog)
    .where(inArray(s.auditLog.entity, AUDIT));
  rows.settings = await db
    .select()
    .from(s.settings)
    .where(inArray(s.settings.key, SETTINGS));
  return rows;
}
function report(rows, now) {
  const bookings = rows.bookings.map((booking) => {
    const payments = rows.payments.filter((p) => p.bookingId === booking.id);
    return {
      ref: booking.ref,
      status: booking.status,
      startAt: booking.startAt,
      client: rows.clients.find((client) => client.id === booking.clientId),
      byCard: payments.some((p) => p.provider === 'stripe'),
      keptCents: payments.reduce(
        (sum, p) => sum + (p.type === 'refund' ? -1 : 1) * p.amountCents,
        0,
      ),
    };
  });
  return {
    bookings,
    keptCents: bookings.reduce(
      (sum, row) => sum + Math.max(0, row.keptCents),
      0,
    ),
    open: {
      checkouts: [...rows.checkoutAttempts, ...rows.paymentBatches].filter(
        (row) =>
          ['creating', 'open'].includes(row.status) && row.expiresAt > now,
      ).length,
      refunds: rows.jobs.filter(
        (job) =>
          job.type === 'refundConflict' &&
          ['pending', 'failed', 'sending'].includes(job.status),
      ).length,
    },
    counts: {
      ...Object.fromEntries(
        TABLES.map(([name, table]) => [name, rows[table].length]),
      ),
      'queued or sent messages': rows.jobs.length,
      'inspiration photos': rows.inspiration.length,
      'change history entries': rows.auditLog.length,
    },
  };
}
export async function previewClear(db, now = new Date()) {
  return report(await collect(db), now);
}
// Deletes every appointment. Styles, prices, the photo library, hours, time off,
// settings, unsubscribes and owner accounts are not touched. Stripe keeps its own
// records, and processed event ids stay so an old message is never applied again.
export async function clearAppointments(
  db,
  { confirm, settled = false, directory, now = new Date() },
) {
  const connection = await db.$client.getConnection();
  let locked = false;
  try {
    const [[lock]] = await connection.query(
      "SELECT GET_LOCK('jobs', 30) AS acquired",
    );
    locked = lock.acquired === 1;
    if (!locked)
      throw new Error('The timer is running. Try again in a minute.');
    return await db.transaction(async (tx) => {
      await tx.select({ id: s.bookings.id }).from(s.bookings).for('update');
      const rows = await collect(tx);
      const found = report(rows, now);
      if (found.bookings.length !== confirm)
        throw new Error(
          `There are ${found.bookings.length} appointments, not ${confirm}. Run the preview again. Nothing was deleted.`,
        );
      if (found.open.checkouts || found.open.refunds)
        throw new Error(
          'A card payment or refund is still open. Wait for it to finish. Nothing was deleted.',
        );
      if (found.keptCents && !settled)
        throw new Error(
          'Some payments have not been refunded. Refund them first, or add --payments-settled if nothing is owed. Nothing was deleted.',
        );
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(
        directory,
        `appointments-${now.toISOString().replace(/[:.]/g, '-')}.json`,
      );
      await writeFile(file, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
      await tx.delete(s.notificationReads);
      for (const [, table] of TABLES) await tx.delete(s[table]);
      for (const [table, list] of [
        [s.jobs, rows.jobs],
        [s.media, rows.inspiration],
        [s.auditLog, rows.auditLog],
      ])
        for (let at = 0; at < list.length; at += 500)
          await tx.delete(table).where(
            inArray(
              table.id,
              list.slice(at, at + 500).map((row) => row.id),
            ),
          );
      await tx.delete(s.settings).where(inArray(s.settings.key, SETTINGS));
      return { ...found, file };
    });
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('jobs')");
    connection.release();
  }
}
