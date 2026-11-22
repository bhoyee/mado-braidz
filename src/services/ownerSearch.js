import { and, or, eq, desc, asc, inArray, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import * as s from '../db/schema.js';
import { studioVideos } from './studioVideos.js';

const pages = [
  ['Overview', '/admin', 'dashboard home totals studio'],
  ['Calendar', '/admin/calendar', 'schedule dates appointments'],
  ['Appointments', '/admin/bookings', 'bookings visits booking'],
  [
    'Payment reviews',
    '/admin/payment-reviews',
    'zelle cash app cashapp transfer proof approval',
  ],
  [
    'Styles & prices',
    '/admin/styles',
    'braids hairstyles prices services menu',
  ],
  ['Extras', '/admin/addons', 'addons add-ons head wash human hair upgrades'],
  [
    'Photos & Our Work',
    '/admin/gallery',
    'gallery portfolio photos images upload',
  ],
  ['Videos', '/admin/gallery#videos', 'films clips video upload'],
  ['Clients', '/admin/clients', 'customers people contacts email phone'],
  [
    'Studio details',
    '/admin/settings',
    'settings business address telephone social policy deposit',
  ],
  [
    'Opening hours',
    '/admin/availability',
    'availability working week time off holidays blocked times',
  ],
  [
    'Sign-in & security',
    '/admin/settings?tab=security',
    'password login account security',
  ],
  ['Notifications', '/admin/notifications', 'bell alerts push reminders'],
  [
    'Payments received this week',
    '/admin/payments?period=week',
    'payments revenue receipts weekly',
  ],
  [
    'Payments received this month',
    '/admin/payments?period=month',
    'payments revenue receipts monthly',
  ],
  ['Outstanding balances', '/admin/balances', 'money owed unpaid balances due'],
];
const termsFor = (q) =>
  q.toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 8);
export function searchPortalPages(query) {
  const terms = termsFor(query);
  if (!terms.length) return [];
  return pages
    .filter(([title, , keywords]) =>
      terms.every((t) => `${title} ${keywords}`.toLowerCase().includes(t)),
    )
    .slice(0, 4)
    .map(([title, href]) => ({ title, href, description: 'Portal page' }));
}
export function createOwnerSearch(db) {
  return async (query) => {
    const terms = termsFor(query);
    const match = (column) =>
      and(...terms.map((term) => sql`LOCATE(${term}, LOWER(${column})) > 0`));
    const digits = /^[+\d().\s-]+$/.test(query) ? query.replace(/\D/g, '') : '';
    const contact = (column) =>
      or(
        match(column),
        ...(digits.length >= 4
          ? [sql`LOCATE(${digits}, ${s.clients.phoneE164}) > 0`]
          : []),
      );
    const [bookings, clients, styles, extras, photos, settings] =
      await Promise.all([
        db
          .select({
            id: s.bookings.id,
            ref: s.bookings.ref,
            name: s.clients.name,
            startAt: s.bookings.startAt,
            styleName: s.styles.name,
            status: s.bookings.status,
          })
          .from(s.bookings)
          .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
          .innerJoin(s.styles, eq(s.bookings.styleId, s.styles.id))
          .where(
            contact(
              sql`CONCAT_WS(' ',${s.clients.name},${s.clients.email},${s.clients.phoneE164},${s.bookings.ref},${s.styles.name},${s.bookings.priceSnapshot},${s.bookings.clientNotes},${s.bookings.adminNotes},'appointment booking')`,
            ),
          )
          .orderBy(desc(s.bookings.createdAt), desc(s.bookings.id))
          .limit(5),
        db
          .select({
            id: s.clients.id,
            name: s.clients.name,
            email: s.clients.email,
          })
          .from(s.clients)
          .where(
            contact(
              sql`CONCAT_WS(' ',${s.clients.name},${s.clients.email},${s.clients.phoneE164},'client customer')`,
            ),
          )
          .orderBy(desc(s.clients.id))
          .limit(10),
        db
          .select({
            id: s.styles.id,
            name: s.styles.name,
            active: s.styles.active,
          })
          .from(s.styles)
          .where(
            match(
              sql`CONCAT_WS(' ',${s.styles.name},${s.styles.slug},${s.styles.shortDesc},'style prices')`,
            ),
          )
          .orderBy(desc(s.styles.active), asc(s.styles.name))
          .limit(4),
        db
          .select({
            id: s.addons.id,
            name: s.addons.name,
            active: s.addons.active,
          })
          .from(s.addons)
          .where(
            match(
              sql`CONCAT_WS(' ',${s.addons.name},${s.addons.description},'extra addon add-on')`,
            ),
          )
          .orderBy(asc(s.addons.sort), asc(s.addons.id))
          .limit(3),
        db
          .select({
            id: s.media.id,
            alt: s.media.alt,
            styleName: s.styles.name,
          })
          .from(s.media)
          .leftJoin(s.styles, eq(s.media.styleId, s.styles.id))
          .where(
            and(
              inArray(s.media.kind, ['style', 'gallery']),
              match(
                sql`CONCAT_WS(' ',${s.media.alt},${s.styles.name},'photo image gallery')`,
              ),
            ),
          )
          .orderBy(asc(s.media.sort), asc(s.media.id))
          .limit(3),
        db
          .select({ value: s.settings.value })
          .from(s.settings)
          .where(eq(s.settings.key, 'videos'))
          .limit(1),
      ]);
    const value = settings[0]?.value;
    const videos = studioVideos({
      videos: typeof value === 'string' ? JSON.parse(value) : value,
    })
      .filter((v) =>
        terms.every((t) =>
          `${v.title} ${v.description} ${(v.locations || []).join(' ')} video film clip`
            .toLowerCase()
            .includes(t),
        ),
      )
      .slice(0, 3);
    const seen = new Set();
    const uniqueClients = clients
      .filter((c) => {
        const key = c.email.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 4);
    return [
      {
        label: 'Appointments',
        items: bookings.map((b) => ({
          title: b.name,
          description: `${b.styleName} · ${DateTime.fromJSDate(b.startAt, { zone: 'America/New_York' }).toFormat('LLL d, yyyy · h:mm a')} · ${b.ref}`,
          href: `/admin/bookings/${b.id}`,
        })),
      },
      {
        label: 'Clients',
        items: uniqueClients.map((c) => ({
          title: c.name,
          description: c.email,
          href: `/admin/clients/${c.id}`,
        })),
      },
      {
        label: 'Styles & prices',
        items: styles.map((v) => ({
          title: v.name,
          description: v.active ? 'Style and prices' : 'Archived style',
          href: `/admin/styles/${v.id}`,
        })),
      },
      {
        label: 'Extras',
        items: extras.map((v) => ({
          title: v.name,
          description: v.active ? 'Extra' : 'Archived extra',
          href: `/admin/addons#extra-${v.id}`,
        })),
      },
      {
        label: 'Photos',
        items: photos.map((v) => ({
          title: v.styleName || v.alt,
          description: v.alt,
          href: `/admin/gallery#photo-${v.id}`,
        })),
      },
      {
        label: 'Videos',
        items: videos.map((v) => ({
          title: v.title,
          description: v.enabled ? 'Published video' : 'Hidden video',
          href: `/admin/gallery#video-${v.id}`,
        })),
      },
    ].filter((group) => group.items.length);
  };
}
