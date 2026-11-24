import { DateTime } from 'luxon';

const ZONE = 'America/New_York';
// Every kind of alert, and the switch that controls it. Locked groups always
// reach the owner: money or a chair is at risk.
export const ALERT_GROUPS = [
  {
    key: 'review',
    name: 'Payments to review',
    text: 'Zelle and Cash App payments waiting for you, and refunds you must check.',
    locked: true,
    types: [
      'payment_review',
      'payment_review_reminder',
      'payment_review_urgent',
      'payment_review_expired',
      'payment_conflict',
    ],
  },
  {
    key: 'bookings',
    name: 'New bookings',
    text: 'A chair is booked.',
    types: ['booking_confirmed', 'booking_paid'],
  },
  {
    key: 'changes',
    name: 'Changes and cancellations',
    text: 'A visit is moved or cancelled.',
    types: ['booking_cancelled', 'booking_rescheduled'],
  },
  {
    key: 'received',
    name: 'Balance payments',
    text: 'A client pays what they owe.',
    types: ['balance_paid', 'payment_received'],
    emailDefault: false,
  },
  {
    key: 'refunds',
    name: 'Refunds',
    text: 'A refund is sent.',
    types: ['refund_issued', 'batch_refund_review'],
  },
  {
    key: 'problems',
    name: 'Problems',
    text: 'A message or payment update could not be delivered.',
    types: [
      'delivery_failure',
      'email_failure',
      'whatsapp_failure',
      'webhook_failure',
    ],
  },
];
const PAYMENTS = ['review', 'received', 'refunds'];
const types = (keys) =>
  ALERT_GROUPS.filter((group) => keys.includes(group.key)).flatMap(
    (group) => group.types,
  );
export const ALERT_VIEWS = {
  all: { name: 'All' },
  unread: { name: 'Unread' },
  bookings: { name: 'Bookings', types: types(['bookings', 'changes']) },
  payments: { name: 'Payments', types: types(PAYMENTS) },
  problems: { name: 'Problems', types: types(['problems']) },
};
export const alertGroup = (type) =>
  ALERT_GROUPS.find((group) => group.types.includes(type));
export const isUrgent = (type) => Boolean(alertGroup(type)?.locked);

// Preferences: email is for the studio, push belongs to each owner.
export function alertPreferences(alerts, adminId) {
  const own = alerts?.owners?.[adminId] || {};
  return {
    email: Object.fromEntries(
      ALERT_GROUPS.map((group) => [
        group.key,
        group.locked ||
          (alerts?.email?.[group.key] ?? group.emailDefault ?? true),
      ]),
    ),
    push: Object.fromEntries(
      ALERT_GROUPS.map((group) => [
        group.key,
        group.locked || (own.push?.[group.key] ?? true),
      ]),
    ),
    names: own.names === true,
    quiet: own.quiet === true,
    quietFrom: own.quietFrom || '22:00',
    quietTo: own.quietTo || '07:00',
  };
}
export function emailAllowed(alerts, type) {
  const group = alertGroup(type);
  return !group || alertPreferences(alerts).email[group.key];
}
export function pushAllowed(prefs, type) {
  const group = alertGroup(type);
  return !group || prefs.push[group.key];
}
// When quiet hours end, or null outside them. Works across midnight.
export function quietUntil(prefs, now) {
  if (!prefs.quiet || prefs.quietFrom === prefs.quietTo) return null;
  const local = DateTime.fromJSDate(now, { zone: ZONE });
  const time = local.toFormat('HH:mm');
  const { quietFrom: from, quietTo: to } = prefs;
  const overnight = from > to;
  const quiet = overnight
    ? time >= from || time < to
    : time >= from && time < to;
  if (!quiet) return null;
  const [hour, minute] = to.split(':').map(Number);
  let end = local.set({ hour, minute, second: 0, millisecond: 0 });
  if (overnight && time >= from) end = end.plus({ days: 1 });
  return end.toJSDate();
}
const usd = (cents) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
const methodNames = { zelle: 'Zelle', cashapp: 'Cash App' };
const when = (date) =>
  DateTime.fromJSDate(new Date(date), { zone: ZONE }).toFormat(
    "ccc, LLL d 'at' h:mm a",
  );
// The appointment an alert is about.
export function alertLink(notification) {
  return {
    id:
      Number(
        /^\/admin\/bookings\/(\d+)$/.exec(notification.url || '')?.[1] || 0,
      ) || null,
    ref:
      /^([A-Z]+-[A-Z0-9]+)(?::|$)/.exec(notification.body || '')?.[1] || null,
  };
}
// Plain words for an alert. `names` is false on lock screens unless chosen.
export function alertText(notification, detail, { names = true } = {}) {
  const { type } = notification;
  const who = (names && detail?.client?.name) || 'A client';
  const style = detail?.booking?.priceSnapshot?.styleName || 'a visit';
  const visit = detail
    ? `${style}, ${when(detail.booking.startAt)}`
    : names
      ? notification.body
      : 'Open your owner studio to see it.';
  const method =
    methodNames[
      /: (zelle|cashapp) payment/.exec(notification.body || '')?.[1]
    ] || '';
  const within = /within (.+)$/.exec(notification.title || '')?.[1];
  const titles = {
    booking_confirmed: detail ? `${who} booked ${style}` : 'New booking',
    booking_paid: detail ? `${who} booked ${style}` : 'New booking',
    payment_review: `${who} sent a ${method ? method + ' ' : ''}payment to review`,
    payment_review_reminder: `Review ${who}’s payment${within ? ` within ${within}` : ''}`,
    payment_review_urgent: `Urgent: review ${who}’s payment now`,
    payment_review_expired: `${who}’s payment was not reviewed in time`,
    payment_conflict: `${who}’s payment needs a refund`,
    balance_paid: `${who} paid the balance`,
    payment_received: `${who} made a payment`,
    booking_cancelled: `${who}’s visit was cancelled`,
    booking_rescheduled: `${who}’s visit was moved`,
    refund_issued: `A refund was sent to ${names && detail?.client?.name ? who : 'a client'}`,
    batch_refund_review: 'Check how a combined refund was split',
    delivery_failure: 'A message or refund needs attention',
    email_failure: 'An email could not be delivered',
    whatsapp_failure: 'A WhatsApp alert could not be delivered',
    webhook_failure: 'A card payment update could not be processed',
  };
  const problem = [
    'delivery_failure',
    'email_failure',
    'whatsapp_failure',
  ].includes(type);
  let body = visit;
  if (problem)
    body = 'See “Needs you” at the top of Notifications for what to do.';
  else if (type === 'webhook_failure')
    body =
      'The studio checks Stripe again by itself. Tell your website support if this repeats.';
  else if (type === 'payment_review_expired' && detail)
    body = `${visit}. The chair was released.`;
  else if (['booking_confirmed', 'booking_paid'].includes(type) && detail) {
    const paid = detail.booking.paidCents;
    body =
      when(detail.booking.startAt) + (paid > 0 ? ` · ${usd(paid)} paid` : '');
  }
  return {
    title: titles[type] || notification.title,
    body,
    urgent: isUrgent(type),
    group: alertGroup(type)?.name || 'Update',
  };
}
export function deviceName(agent = '') {
  const device = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? /Mobile/.test(agent)
          ? 'Android phone'
          : 'Android tablet'
        : /Windows/.test(agent)
          ? 'Windows computer'
          : /Macintosh/.test(agent)
            ? 'Mac or iPad'
            : /CrOS/.test(agent)
              ? 'Chromebook'
              : 'Device';
  const browser = /EdgA?\/|EdgiOS/.test(agent)
    ? 'Edge'
    : /SamsungBrowser/.test(agent)
      ? 'Samsung Internet'
      : /Firefox|FxiOS/.test(agent)
        ? 'Firefox'
        : /Chrome|CriOS/.test(agent)
          ? 'Chrome'
          : /Safari/.test(agent)
            ? 'Safari'
            : '';
  return browser ? `${device} · ${browser}` : device;
}
// Why a message failed, in words the owner can act on.
export function failureText(error, uncertain) {
  if (uncertain)
    return 'We cannot tell whether it arrived. Ask them before doing anything, so they are not messaged twice.';
  if (/No email recipient/i.test(error || ''))
    return 'There is no email address to send to.';
  return 'The delivery service did not accept it.';
}
