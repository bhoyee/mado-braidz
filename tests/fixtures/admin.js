import { DateTime } from 'luxon';
import { presentAppointment } from '../../src/services/adminAppointment.js';
export function memoryAdminRepository(bookings, owner) {
  const rows = [owner];
  let tail = Promise.resolve();
  const repository = {
    rows,
    ownerTwoFactorEnabled: async () =>
      rows.some((r) => r.role === 'owner' && r.totpSecret),
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
    count: async (options) =>
      (await repository.list({ ...options, limit: null, offset: 0 })).length,
    searchClients: async (query) =>
      bookings.clients
        .map((client, index) => ({ id: index + 1, ...client }))
        .filter((c) =>
          [c.name, c.email, c.phoneE164].some((v) =>
            v.toLowerCase().includes(query.toLowerCase()),
          ),
        ),
    clientVisits: async (client, exceptId) => {
      const rows = bookings.rows.filter((b) => {
        const other = bookings.clients[b.clientId - 1];
        return (
          other.email === client.email || other.phoneE164 === client.phoneE164
        );
      });
      return {
        completed: rows.filter((b) => b.status === 'completed').length,
        noShows: rows.filter((b) => b.status === 'no_show').length,
        rows: rows
          .filter((b) => b.id !== exceptId)
          .slice(0, 4)
          .map((b) => ({ ...b, styleName: 'Knotless Braids' })),
      };
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
      upcomingAt,
      statuses,
      reviewOnly = false,
      now = new Date(),
    } = {}) =>
      bookings.rows
        .filter(
          (b) =>
            (!from || b.startAt >= from) &&
            (!to || b.startAt < to) &&
            (!status || b.status === status) &&
            (!statuses || statuses.includes(b.status)) &&
            (!reviewOnly ||
              bookings.proofRows?.some(
                (p) => p.bookingId === b.id && p.status === 'pending',
              )) &&
            (!upcomingAt ||
              b.status === 'confirmed' ||
              (b.status === 'pending_payment' &&
                b.holdExpiresAt > upcomingAt)) &&
            (!liveAt || b.holdExpiresAt > liveAt) &&
            (!balanceOnly ||
              (['confirmed', 'completed'].includes(b.status) &&
                b.balanceCents > 0)) &&
            (!paymentStatus || b.paymentStatus === paymentStatus),
        )
        .map((booking) => {
          const proof = bookings.proofRows
            ?.filter(
              (p) => p.bookingId === booking.id && p.status === 'pending',
            )
            .at(-1);
          const payment = bookings.paymentRows
            .filter((p) => p.bookingId === booking.id && p.type !== 'refund')
            .at(-1);
          return presentAppointment({
            booking,
            client: bookings.clients[booking.clientId - 1],
            paymentMethod:
              proof?.method ||
              payment?.method ||
              (booking.stripeCheckoutSessionId ? 'card' : null),
            paymentProvider: proof
              ? 'manual'
              : payment?.provider ||
                (booking.stripeCheckoutSessionId ? 'stripe' : null),
            paymentReview: proof ? 1 : 0,
          });
        })
        .filter(({ booking, client }) =>
          [booking.ref, client.name, client.email, client.phoneE164].some(
            (value) => value.toLowerCase().includes(search.toLowerCase()),
          ),
        )
        .sort((a, b) =>
          order === 'smart' &&
          a.booking.startAt >= now !== b.booking.startAt >= now
            ? Number(b.booking.startAt >= now) -
              Number(a.booking.startAt >= now)
            : order === 'nearest' ||
                (order === 'smart' && a.booking.startAt >= now)
              ? a.booking.startAt - b.booking.startAt
              : b.booking.startAt - a.booking.startAt,
        )
        .slice(offset, limit === null ? undefined : offset + limit),
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
          (b) =>
            (b.status === 'confirmed' ||
              (b.status === 'pending_payment' && b.holdExpiresAt > now)) &&
            b.startAt >= today,
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
    .set({ hour: 10, minute: 0, second: 0, millisecond: 0 })
    .toUTC()
    .toISO();
}
