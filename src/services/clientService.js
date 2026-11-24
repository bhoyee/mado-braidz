import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import * as s from '../db/schema.js';
import { ManagementError } from './managementErrors.js';
import { optionLabel } from './adminAppointment.js';
import {
  REMOVED_DOMAIN,
  groupClients,
  isRemovedClient,
  wantsNews,
} from './clientGroups.js';

const ZONE = 'America/New_York';
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
const DAY = 86400000;
export const CLIENT_TAGS = [
  'Allergy',
  'Sensitive scalp',
  'Tender-headed',
  'Brings own hair',
  'Prefers quiet',
  'Needs parking help',
  'VIP',
];
// Keys that can hold personal details inside old records.
const PRIVATE_KEYS = new Set([
  'client',
  'name',
  'email',
  'phone',
  'phoneE164',
  'clientNotes',
  'adminNotes',
  'cancelReason',
  'notes',
  'note',
  'tags',
  'reviewNote',
  'inspirationMediaId',
]);
export function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_KEYS.has(key))
      .map(([key, item]) => [key, scrub(item)]),
  );
}
const live = (b, now) =>
  b.status === 'confirmed' ||
  (b.status === 'pending_payment' && b.holdExpiresAt > now);

// Turns the stored records into people with the numbers the owner needs.
export function describeClients(clients, bookings, settings, now) {
  const { people, personOf } = groupClients(clients, settings.links);
  const monthStart = DateTime.fromJSDate(now, { zone: ZONE })
    .startOf('month')
    .toJSDate();
  const visits = new Map(people.map((person) => [person.id, []]));
  for (const booking of bookings) {
    const person = personOf.get(booking.clientId);
    if (person) visits.get(person.id).push(booking);
  }
  const list = people.map((person) => {
    const own = visits
      .get(person.id)
      .sort((a, b) => b.startAt - a.startAt || b.id - a.id);
    const latest = person.rows.at(-1);
    const done = own.filter((b) => b.status === 'completed');
    const ahead = own
      .filter((b) => b.startAt > now && live(b, now))
      .sort((a, b) => a.startAt - b.startAt);
    const past = own.filter(
      (b) => b.startAt <= now && ['completed', 'confirmed'].includes(b.status),
    );
    const kept = own.filter((b) =>
      ['completed', 'confirmed'].includes(b.status),
    );
    const noShows = own.filter((b) => b.status === 'no_show').length;
    const booked =
      kept.length + noShows > 0 || own.some((b) => b.paidCents > 0);
    const firstBooked = [...own]
      .filter(
        (b) =>
          b.paidCents > 0 ||
          ['completed', 'confirmed', 'no_show'].includes(b.status),
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0]?.createdAt;
    const styles = new Map();
    for (const b of kept)
      styles.set(b.styleName, (styles.get(b.styleName) || 0) + 1);
    const favourite = [...styles].sort((a, b) => b[1] - a[1])[0];
    const removed = isRemovedClient(latest);
    const tags = [
      ...new Set(person.ids.flatMap((id) => settings.tags[id] || [])),
    ];
    const balance = own
      .filter((b) => ['completed', 'confirmed'].includes(b.status))
      .reduce((sum, b) => sum + b.balanceCents, 0);
    const lastVisit = past[0]?.startAt || null;
    return {
      ...person,
      name: latest.name,
      email: latest.email,
      phone: latest.phoneE164,
      otherEmails: [
        ...new Set(person.rows.map((row) => row.email.toLowerCase())),
      ].filter((value) => value !== latest.email.toLowerCase()),
      otherPhones: [...new Set(person.rows.map((row) => row.phoneE164))].filter(
        (value) => value && value !== latest.phoneE164,
      ),
      notes: [
        ...new Set(person.rows.map((row) => row.notes?.trim()).filter(Boolean)),
      ].join('\n'),
      tags,
      removed,
      booked,
      visits: own,
      visitCount: kept.length,
      completed: done.length,
      noShows,
      repeat: !removed && kept.length >= 2,
      isNew: Boolean(firstBooked && firstBooked >= monthStart),
      lapsed: Boolean(
        done.length && !ahead.length && +now - +done[0].startAt > 90 * DAY,
      ),
      firstVisit: past.at(-1)?.startAt || null,
      lastVisit,
      nextVisit: ahead[0] || null,
      spentCents: own.reduce((sum, b) => sum + b.paidCents, 0),
      balanceCents: balance,
      favourite: favourite?.[0] || null,
      news: person.rows.some((row) => wantsNews(row, clients)),
      unsubscribed: person.rows.some((row) => row.unsubscribedAt),
      since: person.rows[0].createdAt,
    };
  });
  return { list, personOf };
}
export const clientViews = {
  all: 'All clients',
  repeat: 'Repeat',
  new: 'New this month',
  upcoming: 'Coming up',
  owes: 'Owes a balance',
  lapsed: 'Not seen in 90 days',
  match: 'Possible matches',
  unbooked: 'Not booked yet',
};
const inView = {
  all: (p) => p.booked,
  repeat: (p) => p.booked && p.repeat,
  new: (p) => p.booked && p.isNew,
  upcoming: (p) => p.booked && p.nextVisit,
  owes: (p) => p.booked && p.balanceCents > 0,
  lapsed: (p) => p.booked && p.lapsed,
  match: (p) => p.possible.length > 0,
  unbooked: (p) => !p.booked,
};
const sorts = {
  recent: (a, b) =>
    +(b.lastVisit || b.nextVisit?.startAt || b.since) -
    +(a.lastVisit || a.nextVisit?.startAt || a.since),
  name: (a, b) => a.name.localeCompare(b.name),
  visits: (a, b) => b.visitCount - a.visitCount,
  spent: (a, b) => b.spentCents - a.spentCents,
};
export const clientSorts = {
  recent: 'Most recent visit',
  name: 'Name A to Z',
  visits: 'Most visits',
  spent: 'Most spent',
};
export function filterClients(
  list,
  { search = '', view = 'all', sort = 'recent' },
) {
  const query = search.trim().toLowerCase();
  const digits = /^[+\d().\s-]+$/.test(query) ? query.replace(/\D/g, '') : '';
  const terms = query.split(/\s+/).filter(Boolean);
  return list
    .filter((p) => !p.removed && inView[view](p))
    .filter((p) => {
      if (!query) return true;
      const text = [p.name, p.email, ...p.otherEmails, ...p.tags]
        .join(' ')
        .toLowerCase();
      const numbers = [p.phone, ...p.otherPhones]
        .join(' ')
        .replace(/[^\d ]/g, '');
      return (
        terms.every((term) => text.includes(term)) ||
        (digits.length >= 3 && numbers.includes(digits))
      );
    })
    .sort((a, b) => sorts[sort](a, b) || b.id - a.id);
}

export function createClientService(db, clock = () => new Date()) {
  const audit = (tx, actor, id, action, before, after) =>
    tx.insert(s.auditLog).values({
      adminId: actor.id,
      ip: actor.ip,
      entity: 'client',
      entityId: id,
      action,
      before,
      after,
    });
  async function settings(tx = db, lock = false) {
    const keys = ['clientLinks', 'clientTags'];
    if (lock)
      for (const key of keys)
        await tx
          .insert(s.settings)
          .values({ key, value: {}, updatedAt: new Date() })
          .onDuplicateKeyUpdate({ set: { key } });
    let query = tx
      .select()
      .from(s.settings)
      .where(inArray(s.settings.key, keys))
      .orderBy(s.settings.key);
    if (lock) query = query.for('update');
    const rows = Object.fromEntries(
      (await query).map((row) => [row.key, decode(row.value)]),
    );
    return { links: rows.clientLinks || {}, tags: rows.clientTags || {} };
  }
  const store = (tx, key, value, actor) =>
    tx
      .update(s.settings)
      .set({ value, updatedAt: new Date(), updatedBy: actor.id })
      .where(eq(s.settings.key, key));
  async function load(tx = db, held = null) {
    const [clients, bookings, saved] = await Promise.all([
      tx.select().from(s.clients),
      tx
        .select({
          id: s.bookings.id,
          ref: s.bookings.ref,
          clientId: s.bookings.clientId,
          status: s.bookings.status,
          paymentStatus: s.bookings.paymentStatus,
          startAt: s.bookings.startAt,
          endAt: s.bookings.endAt,
          createdAt: s.bookings.createdAt,
          holdExpiresAt: s.bookings.holdExpiresAt,
          paidCents: s.bookings.paidCents,
          balanceCents: s.bookings.balanceCents,
          subtotalCents: s.bookings.subtotalCents,
          styleId: s.bookings.styleId,
          styleVariantId: s.bookings.styleVariantId,
          priceSnapshot: s.bookings.priceSnapshot,
        })
        .from(s.bookings),
      held || settings(tx),
    ]);
    const rows = bookings.map(({ priceSnapshot, ...b }) => {
      const price = decode(priceSnapshot) || {};
      return {
        ...b,
        styleName: price.styleName || 'Appointment',
        option: optionLabel([price.size, price.length]),
      };
    });
    return describeClients(clients, rows, saved, clock());
  }
  async function person(id, tx = db, held = null) {
    const { personOf, list } = await load(tx, held);
    const group = personOf.get(id);
    const found = group && list.find((item) => item.id === group.id);
    if (!found) throw new ManagementError('Client not found');
    return { found, list };
  }
  const lockRows = (tx, ids) =>
    tx.select().from(s.clients).where(inArray(s.clients.id, ids)).for('update');
  const notRemoved = (found) => {
    if (found.removed)
      throw new ManagementError('This client’s details were removed.');
  };
  const jobsFor = (ids, bookingIds) =>
    sql`(JSON_EXTRACT(${s.jobs.payload}, '$.clientId') IN (${sql.join(ids, sql`, `)})${
      bookingIds.length
        ? sql` OR JSON_EXTRACT(${s.jobs.payload}, '$.bookingId') IN (${sql.join(bookingIds, sql`, `)})`
        : sql``
    })`;
  return {
    async directory(filter) {
      const { list } = await load();
      const counted = list.filter((p) => !p.removed);
      const booked = counted.filter((p) => p.booked);
      const rows = filterClients(list, filter);
      const size = filter.all ? rows.length : 20;
      const first = ((filter.page || 1) - 1) * size;
      const repeat = booked.filter((p) => p.repeat).length;
      return {
        rows: rows.slice(first, first + size),
        total: rows.length,
        first,
        hasNext: first + size < rows.length,
        cards: {
          total: booked.length,
          repeat,
          repeatPercent: booked.length
            ? Math.round((repeat / booked.length) * 100)
            : 0,
          fresh: booked.filter((p) => p.isNew).length,
          lapsed: booked.filter((p) => p.lapsed).length,
        },
        counts: Object.fromEntries(
          Object.keys(clientViews).map((view) => [
            view,
            counted.filter(inView[view]).length,
          ]),
        ),
      };
    },
    async profile(id) {
      const { found, list } = await person(id);
      const bookingIds = found.visits.map((b) => b.id);
      const [emails, history, jobs, saved] = await Promise.all([
        db
          .select()
          .from(s.emailLog)
          .where(
            bookingIds.length
              ? sql`(${s.emailLog.clientId} IN (${sql.join(found.ids, sql`, `)}) OR ${s.emailLog.bookingId} IN (${sql.join(bookingIds, sql`, `)}))`
              : inArray(s.emailLog.clientId, found.ids),
          )
          .orderBy(desc(s.emailLog.id))
          .limit(30),
        db
          .select({ entry: s.auditLog, name: s.admins.name })
          .from(s.auditLog)
          .innerJoin(s.admins, eq(s.auditLog.adminId, s.admins.id))
          .where(
            and(
              eq(s.auditLog.entity, 'client'),
              inArray(s.auditLog.entityId, found.ids),
            ),
          )
          .orderBy(desc(s.auditLog.id))
          .limit(30),
        db
          .select()
          .from(s.jobs)
          .where(
            and(
              eq(s.jobs.type, 'winback'),
              eq(s.jobs.status, 'pending'),
              jobsFor(found.ids, bookingIds),
            ),
          ),
        settings(),
      ]);
      return {
        ...found,
        emails,
        history: history.map(({ entry, name }) => ({
          ...entry,
          before: decode(entry.before),
          after: decode(entry.after),
          by: name,
        })),
        winbacks: jobs,
        matches: list
          .filter((p) => found.possible.includes(p.id) && !p.removed)
          .map((p) => ({
            id: p.id,
            name: p.name,
            email: p.email,
            phone: p.phone,
            visitCount: p.visitCount,
          })),
        joined: (saved.links.join || [])
          .filter(([a, b]) => found.ids.includes(a) && found.ids.includes(b))
          .map(([a, b]) => ({
            pair: `${a}-${b}`,
            names: [a, b].map((id2) => {
              const row = found.rows.find((r) => r.id === id2);
              return `${row.name} (${row.email})`;
            }),
          })),
      };
    },
    // What appointments and new bookings need to know about the person.
    async summary(id) {
      const { found } = await person(id);
      return found;
    },
    async saveDetails(id, input, actor) {
      await db.transaction(async (tx) => {
        const held = await settings(tx, true);
        const { found, list } = await person(id, tx, held);
        notRemoved(found);
        await lockRows(tx, found.ids);
        const taken = list.find(
          (p) =>
            p.id !== found.id &&
            !p.removed &&
            p.rows.some(
              (row) =>
                row.email.trim().toLowerCase() === input.email.toLowerCase(),
            ),
        );
        if (taken)
          throw new ManagementError(
            `That email belongs to ${taken.name}. Join the two clients instead.`,
          );
        const values = {
          name: input.name,
          email: input.email,
          phoneE164: input.phone,
        };
        await tx
          .update(s.clients)
          .set(values)
          .where(inArray(s.clients.id, found.ids));
        await audit(
          tx,
          actor,
          found.id,
          'edit',
          { name: found.name, email: found.email, phone: found.phone },
          { name: values.name, email: values.email, phone: values.phoneE164 },
        );
      });
    },
    async saveNotes(id, { notes, tags }, actor) {
      await db.transaction(async (tx) => {
        const held = await settings(tx, true);
        const { found } = await person(id, tx, held);
        notRemoved(found);
        await lockRows(tx, found.ids);
        await tx
          .update(s.clients)
          .set({ notes: notes || null })
          .where(inArray(s.clients.id, found.ids));
        const next = { ...held.tags };
        for (const old of found.ids) delete next[old];
        if (tags.length) next[found.id] = [...new Set(tags)];
        await store(tx, 'clientTags', next, actor);
        await audit(
          tx,
          actor,
          found.id,
          'notes',
          { notes: found.notes, tags: found.tags },
          { notes, tags },
        );
      });
    },
    async stopNews(id, actor) {
      await db.transaction(async (tx) => {
        const { found } = await person(id, tx);
        notRemoved(found);
        await tx
          .update(s.clients)
          .set({ marketingConsent: false, unsubscribedAt: clock() })
          .where(inArray(s.clients.id, found.ids));
        await tx
          .update(s.jobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              eq(s.jobs.type, 'winback'),
              inArray(s.jobs.status, ['pending', 'failed']),
              jobsFor(
                found.ids,
                found.visits.map((b) => b.id),
              ),
            ),
          );
        await audit(
          tx,
          actor,
          found.id,
          'unsubscribe',
          { news: found.news },
          { news: false },
        );
      });
    },
    async link(id, otherId, how, actor) {
      await db.transaction(async (tx) => {
        const held = await settings(tx, true);
        const { found, list } = await person(id, tx, held);
        const other = list.find((p) => p.ids.includes(otherId));
        if (!other || other.id === found.id)
          throw new ManagementError('Refresh the page and try again');
        notRemoved(found);
        notRemoved(other);
        const pair = [found.id, other.id].sort((a, b) => a - b);
        const links = {
          ...held.links,
          [how]: [...(held.links[how] || []), pair],
        };
        await store(tx, 'clientLinks', links, actor);
        for (const key of pair)
          await audit(
            tx,
            actor,
            key,
            how === 'join' ? 'join' : 'keep-apart',
            null,
            {
              clients: pair,
            },
          );
      });
    },
    async unlink(id, pair, actor) {
      await db.transaction(async (tx) => {
        const held = await settings(tx, true);
        const { found } = await person(id, tx, held);
        const join = held.links.join || [];
        const rest = join.filter(([a, b]) => a !== pair[0] || b !== pair[1]);
        if (rest.length === join.length || !found.ids.includes(pair[0]))
          throw new ManagementError('Refresh the page and try again');
        await store(tx, 'clientLinks', { ...held.links, join: rest }, actor);
        for (const key of pair)
          await audit(tx, actor, key, 'undo-join', null, { clients: pair });
      });
    },
    // For privacy requests. Dates and amounts stay, because payments and totals
    // depend on them; everything that identifies the person goes.
    async removeDetails(id, actor) {
      await db.transaction(async (tx) => {
        const held = await settings(tx, true);
        const { found } = await person(id, tx, held);
        notRemoved(found);
        const rows = await lockRows(tx, found.ids);
        const bookingIds = found.visits.map((b) => b.id);
        const now = clock();
        if (bookingIds.length) {
          const bookings = await tx
            .select()
            .from(s.bookings)
            .where(inArray(s.bookings.id, bookingIds))
            .for('update');
          if (
            bookings.some(
              (b) =>
                (b.status === 'confirmed' && b.endAt > now) ||
                b.status === 'pending_payment' ||
                b.status === 'payment_conflict',
            )
          )
            throw new ManagementError(
              'This client has an upcoming or unfinished booking. Complete or cancel it first.',
            );
          if (
            bookings.some(
              (b) =>
                ['confirmed', 'completed'].includes(b.status) &&
                b.balanceCents > 0,
            )
          )
            throw new ManagementError(
              'This client still has a balance. Settle it first.',
            );
          const [attempt] = await tx
            .select({ id: s.checkoutAttempts.id })
            .from(s.checkoutAttempts)
            .where(
              and(
                inArray(s.checkoutAttempts.bookingId, bookingIds),
                inArray(s.checkoutAttempts.status, ['creating', 'open']),
              ),
            )
            .limit(1);
          const [proof] = await tx
            .select({ id: s.paymentProofs.id })
            .from(s.paymentProofs)
            .where(
              and(
                inArray(s.paymentProofs.bookingId, bookingIds),
                eq(s.paymentProofs.status, 'pending'),
              ),
            )
            .limit(1);
          const [refund] = await tx
            .select({ id: s.jobs.id })
            .from(s.jobs)
            .where(
              and(
                eq(s.jobs.type, 'refundConflict'),
                inArray(s.jobs.status, ['pending', 'failed']),
                jobsFor(found.ids, bookingIds),
              ),
            )
            .limit(1);
          if (attempt || proof || refund)
            throw new ManagementError(
              'A payment or refund is still open for this client. Finish it first.',
            );
          await tx
            .update(s.bookings)
            .set({
              clientNotes: null,
              adminNotes: null,
              cancelReason: null,
              inspirationMediaId: null,
            })
            .where(inArray(s.bookings.id, bookingIds));
          const media = bookings
            .map((b) => b.inspirationMediaId)
            .filter(Boolean);
          if (media.length)
            await tx
              .delete(s.media)
              .where(
                and(
                  inArray(s.media.id, media),
                  eq(s.media.kind, 'inspiration'),
                ),
              );
          await tx
            .update(s.paymentProofs)
            .set({ path: 'removed', reviewNote: null })
            .where(inArray(s.paymentProofs.bookingId, bookingIds));
          await tx.delete(s.notifications).where(
            inArray(
              s.notifications.url,
              bookingIds.flatMap((key) => [
                `/admin/bookings/${key}`,
                `/admin/bookings/${key}#payment-review`,
              ]),
            ),
          );
        }
        const address = `removed-${found.id}${REMOVED_DOMAIN}`;
        await tx
          .update(s.clients)
          .set({
            name: 'Removed client',
            email: address,
            phoneE164: '',
            notes: null,
            marketingConsent: false,
            consentAt: null,
            unsubscribedAt: now,
          })
          .where(inArray(s.clients.id, found.ids));
        await tx
          .update(s.emailLog)
          .set({ toEmail: address })
          .where(
            bookingIds.length
              ? sql`(${s.emailLog.clientId} IN (${sql.join(found.ids, sql`, `)}) OR ${s.emailLog.bookingId} IN (${sql.join(bookingIds, sql`, `)})) AND LOWER(${s.emailLog.toEmail}) IN (${sql.join(
                  rows.map((row) => row.email.toLowerCase()),
                  sql`, `,
                )})`
              : inArray(s.emailLog.clientId, found.ids),
          );
        // Waiting messages are stopped, and old message contents cleared.
        await tx
          .update(s.jobs)
          .set({ status: 'cancelled' })
          .where(
            and(
              inArray(s.jobs.type, ['email', 'reminder', 'winback']),
              inArray(s.jobs.status, ['pending', 'failed']),
              jobsFor(found.ids, bookingIds),
            ),
          );
        for (const row of rows)
          await tx
            .update(s.jobs)
            .set({ payload: { removed: true }, status: 'cancelled' })
            .where(
              and(
                inArray(s.jobs.type, ['email', 'reminder', 'winback']),
                sql`LOCATE(${row.email.toLowerCase()}, LOWER(CAST(${s.jobs.payload} AS CHAR))) > 0`,
              ),
            );
        const logs = await tx
          .select()
          .from(s.auditLog)
          .where(
            bookingIds.length
              ? sql`(${s.auditLog.entity} = 'booking' AND ${s.auditLog.entityId} IN (${sql.join(bookingIds, sql`, `)})) OR (${s.auditLog.entity} = 'client' AND ${s.auditLog.entityId} IN (${sql.join(found.ids, sql`, `)}))`
              : and(
                  eq(s.auditLog.entity, 'client'),
                  inArray(s.auditLog.entityId, found.ids),
                ),
          );
        for (const entry of logs)
          await tx
            .update(s.auditLog)
            .set({
              before: scrub(decode(entry.before)),
              after: scrub(decode(entry.after)),
            })
            .where(eq(s.auditLog.id, entry.id));
        const tags = { ...held.tags };
        for (const key of found.ids) delete tags[key];
        await store(tx, 'clientTags', tags, actor);
        await audit(tx, actor, found.id, 'remove-details', null, {
          removed: true,
        });
      });
    },
  };
}
