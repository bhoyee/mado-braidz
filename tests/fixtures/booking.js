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
  let tail = Promise.resolve();
  const repository = {
    data,
    rows,
    clients,
    media,
    timeBlocks: [],
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
      rows.push(values);
      return rows.length;
    },
    transaction: async (run) => {
      const previous = tail;
      let release;
      tail = new Promise((resolve) => {
        release = resolve;
      });
      await previous;
      const lengths = [rows.length, clients.length, media.length];
      try {
        return await run(repository);
      } catch (e) {
        rows.length = lengths[0];
        clients.length = lengths[1];
        media.length = lengths[2];
        throw e;
      } finally {
        release();
      }
    },
  };
  return repository;
}
