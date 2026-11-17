import { DateTime } from 'luxon';
import { fixtureCatalog } from './catalog.js';
export const now = DateTime.fromISO('2026-12-01T12:00:00Z');
export const validHold = {
  styleId: 1,
  styleVariantId: 101,
  addonIds: [],
  paymentChoice: 'deposit',
  startAt: '2026-12-03T14:00:00Z',
  name: 'Test Client',
  email: 'client@example.test',
  phone: '+14437434979',
  notes: '',
  policyAccepted: true,
  marketingConsent: false,
};
export async function memoryBookingRepository() {
  const data = await fixtureCatalog().load();
  const rows = [],
    clients = [],
    media = [];
  const attempts = [],
    batches = [],
    proofs = [],
    audits = [],
    payments = [],
    events = [],
    jobs = [],
    notifications = [];
  let tail = Promise.resolve();
  const repository = {
    data,
    rows,
    clients,
    media,
    timeBlocks: [],
    attemptRows: attempts,
    paymentRows: payments,
    eventRows: events,
    jobRows: jobs,
    notificationRows: notifications,
    batchRows: batches,
    expiredBatches: async (now) =>
      batches
        .filter(
          (b) => ['creating', 'open'].includes(b.status) && b.expiresAt < now,
        )
        .map((b) => ({ id: b.id })),
    batch: async (id) => batches.find((b) => b.id === id),
    batchBySession: async (id) => batches.find((b) => b.stripeSessionId === id),
    batchByIntent: async (id) =>
      batches.find((b) => b.stripePaymentIntentId === id),
    insertBatch: async (values) => batches.push({ ...values }),
    saveBatch: async (id, values) =>
      Object.assign(
        batches.find((b) => b.id === id),
        values,
      ),
    paymentMatches: async (kind, value) =>
      rows.filter((row) => {
        const client = clients[row.clientId - 1];
        return kind === 'ref'
          ? row.ref === value
          : kind === 'email'
            ? client.email.toLowerCase() === value
            : client.phoneE164 === value;
      }),
    proofRows: proofs,
    auditRows: audits,
    proofs: async (id) => proofs.filter((p) => !id || p.bookingId === id),
    proof: async (id) => proofs.find((p) => p.id === id),
    insertProof: async (values) => {
      proofs.push({ ...values, id: proofs.length + 1 });
      return proofs.length;
    },
    saveProof: async (id, values) =>
      Object.assign(
        proofs.find((p) => p.id === id),
        values,
      ),
    audit: async (values) => audits.push(values),
    updateClient: async (id, values) => Object.assign(clients[id - 1], values),
    replaceAddons: async () => {},
    bookingJobs: async (id) =>
      jobs.filter((job) => job.payload.bookingId === id),
    paymentByRequest: async (key) =>
      payments.find((p) => p.adminRequestKey === key),
    bookingById: async (id) => rows.find((r) => r.id === id),
    bookingByRef: async (ref) => rows.find((r) => r.ref === ref),
    bookingByToken: async (hash) =>
      rows.find((r) => r.manageTokenHash === hash),
    bookingByRequest: async (key) =>
      rows.find((r) => r.checkoutRequestKey === key),
    saveBooking: async (id, values) =>
      Object.assign(
        rows.find((r) => r.id === id),
        values,
      ),
    client: async (id) => clients[id - 1],
    attempt: async (id) => attempts.find((a) => a.id === id),
    attempts: async (id) => attempts.filter((a) => a.bookingId === id),
    attemptBySession: async (id) =>
      attempts.find((a) => a.stripeSessionId === id),
    insertAttempt: async (values) => attempts.push({ ...values }),
    saveAttempt: async (id, values) =>
      Object.assign(
        attempts.find((a) => a.id === id),
        values,
      ),
    payments: async (id) => payments.filter((p) => p.bookingId === id),
    paymentByIntent: async (id) =>
      payments.find(
        (p) => p.stripePaymentIntentId === id && p.type !== 'refund',
      ),
    insertPayment: async (values) =>
      payments.push({
        id: payments.length + 1,
        createdAt: new Date(),
        ...values,
      }),
    event: async (id, type, receivedAt) => {
      let row = events.find((e) => e.id === id);
      if (!row) {
        row = { id, type, receivedAt };
        events.push(row);
      }
      return row;
    },
    finishEvent: async (id, processedAt) =>
      Object.assign(
        events.find((e) => e.id === id),
        { processedAt },
      ),
    queueJob: async (values) => {
      if (!jobs.some((j) => j.dedupeKey === values.dedupeKey))
        jobs.push({ ...values, id: jobs.length + 1, attempts: 0 });
    },
    refundJobs: async (id) =>
      jobs.filter(
        (j) =>
          j.type === 'refundConflict' &&
          ['pending', 'failed'].includes(j.status) &&
          (!id || j.payload.bookingId === id),
      ),
    saveJob: async (id, values) =>
      Object.assign(
        jobs.find((j) => j.id === id),
        values,
      ),
    notify: async (values) => notifications.push(values),
    expiredHolds: async (now) =>
      rows
        .filter((r) => r.status === 'pending_payment' && r.holdExpiresAt < now)
        .map((r) => ({ id: r.id })),
    catalog: async () => structuredClone(data),
    schedule: async () => ({
      bookings: structuredClone(rows),
      timeBlocks: repository.timeBlocks,
    }),
    lockDates: async () => {},
    insertClient: async (values) => {
      clients.push(values);
      return clients.length;
    },
    insertMedia: async (values) => {
      media.push(values);
      return media.length;
    },
    insertBooking: async (values) => {
      rows.push({ ...values, id: rows.length + 1 });
      return rows.length;
    },
    transaction: async (run) => {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      const arrays = [
        rows,
        clients,
        media,
        attempts,
        batches,
        payments,
        events,
        jobs,
        notifications,
        proofs,
        audits,
      ];
      const snapshots = arrays.map((array) => structuredClone(array));
      try {
        return await run(repository);
      } catch (e) {
        arrays.forEach((array, i) =>
          array.splice(0, array.length, ...snapshots[i]),
        );
        throw e;
      } finally {
        release();
      }
    },
  };
  return repository;
}
