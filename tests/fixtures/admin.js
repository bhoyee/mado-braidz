import { DateTime } from 'luxon';
export function memoryAdminRepository(bookings, owner) {
  const rows = [owner];
  let tail = Promise.resolve();
  const repository = {
    rows,
    auditList: async (offset = 0) =>
      bookings.auditRows
        .slice()
        .reverse()
        .slice(offset, offset + 101)
        .map((entry) => ({
          name: owner.name,
          entry: { createdAt: new Date(), ...entry },
        })),
    adminByEmail: async (email) => rows.find((r) => r.email === email),
    adminById: async (id) => rows.find((r) => r.id === id),
    adminByReset: async (hash) => rows.find((r) => r.resetTokenHash === hash),
    saveAdmin: async (id, values) =>
      Object.assign(
        rows.find((r) => r.id === id),
        values,
      ),
    audit: async (values) => bookings.auditRows.push(values),
    transaction: async (run) => {
      const previous = tail;
      let release;
      tail = new Promise((done) => {
        release = done;
      });
      await previous;
      try {
        return await run(repository);
      } finally {
        release();
      }
    },
    list: async ({
      from,
      to,
      status,
      paymentStatus,
      search = '',
      limit = 100,
      offset = 0,
      order = 'latest',
      liveAt,
      balanceOnly = false,
    } = {}) =>
      bookings.rows
        .filter(
          (b) =>
            (!from || b.startAt >= from) &&
            (!to || b.startAt < to) &&
            (!status || b.status === status) &&
            (!liveAt || b.holdExpiresAt > liveAt) &&
            (!balanceOnly ||
              (['confirmed', 'completed'].includes(b.status) &&
                b.balanceCents > 0)) &&
            (!paymentStatus || b.paymentStatus === paymentStatus),
        )
        .map((booking) => ({
          booking,
          client: bookings.clients[booking.clientId - 1],
        }))
        .filter(({ booking, client }) =>
          [booking.ref, client.name, client.email, client.phoneE164].some(
            (value) => value.toLowerCase().includes(search.toLowerCase()),
          ),
        )
        .sort((a, b) =>
          order === 'nearest'
            ? a.booking.startAt - b.booking.startAt
            : b.booking.startAt - a.booking.startAt,
        )
        .slice(offset, offset + limit),
    receipts: async ({ from, to, offset = 0, limit = 101 }) =>
      bookings.paymentRows
        .filter((p) => p.createdAt >= from && p.createdAt < to)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(offset, offset + limit)
        .map((payment) => {
          const booking = bookings.rows.find((b) => b.id === payment.bookingId);
          return {
            payment,
            booking,
            client: bookings.clients[booking.clientId - 1],
          };
        }),
    metrics: async (startWeek, startMonth, now, today) => {
      const total = (from) =>
        bookings.paymentRows
          .filter((p) => p.createdAt >= from && p.createdAt < now)
          .reduce(
            (sum, p) =>
              sum + (p.type === 'refund' ? -p.amountCents : p.amountCents),
            0,
          );
      return {
        week: total(startWeek),
        month: total(startMonth),
        owed: bookings.rows
          .filter(
            (b) =>
              ['confirmed', 'completed'].includes(b.status) &&
              b.balanceCents > 0,
          )
          .reduce((sum, b) => sum + b.balanceCents, 0),
        pending: bookings.rows.filter(
          (b) => b.status === 'confirmed' && b.startAt >= today,
        ).length,
      };
    },
    detail: async (id) => {
      const booking = await bookings.bookingById(id);
      if (!booking) return null;
      return {
        booking,
        client: await bookings.client(booking.clientId),
        payments: await bookings.payments(id),
        emails: [],
        audits: bookings.auditRows
          .filter((a) => a.entity === 'booking' && a.entityId === id)
          .map((a) => ({ createdAt: new Date(), ...a })),
        inspiration: null,
      };
    },
  };
  return repository;
}
export function futureStart() {
  return DateTime.now()
    .setZone('America/New_York')
    .plus({ days: 3 })
    .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
}
