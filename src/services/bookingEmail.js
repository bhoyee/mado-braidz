// Builds the content of booking emails. Amounts and times come from the stored
// booking; rendering and escaping happen in src/views/emails/booking.html.njk.
import { DateTime } from 'luxon';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { publicSettings } from '../db/public-defaults.js';

const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
export const usd = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    (cents || 0) / 100,
  );
const et = (value, format) =>
  DateTime.fromJSDate(new Date(value), { zone: 'America/New_York' })
    .setLocale('en-US')
    .toFormat(format);
const LONG = 'cccc, LLLL d, yyyy',
  SHORT = "ccc LLL d 'at' h:mm a",
  STAMP = "ccc, LLL d 'at' h:mm a";
const sizes = { medium: 'Medium', semi_medium: 'Semi-medium', small: 'Small' };
const lengths = {
  shoulder: 'shoulder',
  mid_back: 'mid-back',
  waist: 'waist',
  top_butt: 'top butt',
  butt: 'butt',
  under_butt: 'under butt',
};
const methods = {
  card: 'card',
  cash: 'cash',
  zelle: 'Zelle',
  cashapp: 'Cash App',
};
const violet = { badge: '#cdb6f2', ground: '#f4eefb', text: '#5f2d9e' },
  amber = { badge: '#e0b26a', ground: '#fbf1de', text: '#7a4a00' };
const GOOD = '#2f7d4f',
  WARN = '#7a4a00';

function ordinal(n) {
  const tail = n % 100;
  return (
    n +
    (tail >= 11 && tail <= 13
      ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')
  );
}
const firstName = (client) => oneLine(client?.name).split(' ')[0] || '';
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function styleSection(snapshot, title = 'Style') {
  const look = [sizes[snapshot.size], lengths[snapshot.length]].filter(Boolean);
  const extras = (snapshot.addons || []).map((a) => oneLine(a.name));
  return {
    title,
    lead: oneLine(snapshot.styleName) || 'Booked hairstyle',
    lines: [
      look.length && { text: cap(look.join(', ')) },
      extras.length && { text: 'Extras: ' + extras.join(', ') },
    ].filter(Boolean),
  };
}
const time = (booking) =>
  booking.endAt
    ? `${et(booking.startAt, 'h:mm a')} to ${et(booking.endAt, 'h:mm a')} Eastern`
    : `${et(booking.startAt, 'h:mm a')} Eastern`;
function paidLabel(booking, payments, owner) {
  const received = (payments || []).filter((p) => p.type !== 'refund');
  // Only name a method when one payment accounts for the whole amount.
  if (
    received.length === 1 &&
    received[0].amountCents === booking.paidCents &&
    methods[received[0].method]
  ) {
    const by = ` by ${methods[received[0].method]}`;
    const kind = { deposit: 'deposit', full: 'in full' }[received[0].type];
    if (received[0].type === 'deposit')
      return owner ? `Paid: deposit${by}` : `Deposit paid${by}`;
    return kind ? `Paid ${kind}${by}` : `Paid${by}`;
  }
  return 'Paid so far';
}
function rejectedSection(booking, snapshot, payload) {
  const rows = [
    {
      label: `${methods[payload.method] || 'Transfer'} payment ${payload.template === 'payment-review-expired' ? 'sent, not yet verified' : 'not verified'}`,
      value: usd(payload.amountCents),
      color: WARN,
      strong: true,
    },
  ];
  if (payload.paymentType === 'balance')
    rows.push({
      label: 'Balance remaining',
      value: snapshot.consultation
        ? 'Agreed at consultation'
        : usd(Math.max(0, booking.balanceCents)),
      wrap: Boolean(snapshot.consultation),
      total: true,
    });
  return { title: 'Payment', rows };
}
// Whole Eastern calendar days, so a late-evening reminder still says tomorrow.
function dayLabel(startAt, now) {
  const day = (value) =>
    DateTime.fromJSDate(new Date(value), { zone: 'America/New_York' }).startOf(
      'day',
    );
  const days = Math.round(day(startAt).diff(day(now), 'days').days);
  return days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
}
function submittedSection(booking, snapshot, proof) {
  const consultation = Boolean(snapshot.consultation);
  const rows = [
    {
      label: 'Total',
      value: consultation
        ? 'Agreed at consultation'
        : usd(booking.subtotalCents ?? snapshot.subtotalCents),
      wrap: consultation,
    },
  ];
  if (booking.paidCents > 0)
    rows.push({ label: 'Paid so far', value: usd(booking.paidCents) });
  rows.push(
    {
      label: `${methods[proof.method]} payment sent (awaiting verification)`,
      value: usd(proof.amountCents),
      color: WARN,
      strong: true,
    },
    {
      label: 'Balance after verification',
      value: consultation
        ? 'Agreed at consultation'
        : usd(Math.max(0, booking.balanceCents - proof.amountCents)),
      wrap: consultation,
      total: true,
    },
  );
  return { title: 'Payment', rows };
}
function paymentSection(booking, snapshot, payments, owner, refundCents) {
  const consultation = Boolean(snapshot.consultation);
  const total =
    booking.subtotalCents ??
    snapshot.subtotalCents ??
    booking.paidCents + booking.balanceCents;
  const rows = [
    {
      label: 'Total',
      value: consultation ? 'Agreed at consultation' : usd(total),
      wrap: consultation,
    },
    {
      label: paidLabel(booking, payments, owner),
      value: usd(booking.paidCents),
      color: booking.paidCents > 0 ? GOOD : undefined,
      strong: true,
    },
  ];
  if (Number.isSafeInteger(refundCents))
    rows.push({ label: 'Refund', value: usd(refundCents), strong: true });
  // Nothing is collected for an appointment that is no longer going ahead.
  if (['pending_payment', 'confirmed', 'completed'].includes(booking.status))
    rows.push({
      label:
        !consultation && booking.balanceCents <= 0
          ? owner
            ? 'Nothing to collect'
            : 'Nothing left to pay'
          : owner
            ? 'Balance to collect'
            : 'Balance remaining',
      value: consultation
        ? 'Agreed at consultation'
        : usd(Math.max(0, booking.balanceCents)),
      wrap: consultation,
      total: true,
    });
  return { title: 'Payment', rows };
}
function clientSection(client, visits) {
  const phone = parsePhoneNumberFromString(client?.phoneE164 || '');
  return {
    title: 'Client',
    lead: oneLine(client?.name) || 'Client',
    lines: [
      phone && {
        text:
          phone.country === 'US'
            ? phone.formatNational()
            : phone.formatInternational(),
        href: 'tel:' + phone.number,
      },
      client?.email && {
        text: oneLine(client.email),
        href:
          'mailto:' +
          encodeURIComponent(oneLine(client.email)).replace('%40', '@'),
      },
      Number.isSafeInteger(visits) && {
        text:
          visits > 0
            ? `Returning client, ${ordinal(visits + 1)} visit`
            : 'First recorded visit',
      },
    ].filter(Boolean),
  };
}
function noteSection(booking) {
  const note = String(booking.clientNotes || '').trim();
  const photo = booking.inspirationMediaId
    ? 'An inspiration photo was sent. Sign in to see it.'
    : '';
  if (!note && !photo) return null;
  return note
    ? { title: 'Client’s note', note, after: photo }
    : { title: 'Inspiration photo', lines: [{ text: photo }] };
}

// Owner alert, or null when the booking has moved on and the short generic
// alert is more accurate.
export function ownerBookingMail(kind, detail, extras = {}, appUrl, payload) {
  const { booking, client } = detail || {};
  if (!booking || !client) return null;
  const snapshot = booking.priceSnapshot || {};
  const proof = extras.proof;
  const allowed = {
    booking_confirmed: booking.status === 'confirmed',
    booking_rescheduled: booking.status === 'confirmed',
    booking_cancelled: booking.status === 'cancelled',
    payment_review: proof?.status === 'pending',
    payment_review_reminder:
      proof?.status === 'pending' && booking.status === 'pending_payment',
    payment_review_urgent:
      proof?.status === 'pending' && booking.status === 'pending_payment',
    payment_review_expired:
      proof?.status === 'pending' && booking.status === 'expired',
  }[kind];
  if (!allowed) return null;
  const name = oneLine(client.name) || 'Client';
  const when = et(booking.startAt, SHORT);
  const portal =
    appUrl +
    (payload?.url?.startsWith('/admin')
      ? payload.url
      : `/admin/bookings/${booking.id}`);
  const phone = parsePhoneNumberFromString(client.phoneE164 || '');
  const call = phone && {
    label: `Call ${firstName(client) || 'client'}`,
    href: 'tel:' + phone.number,
  };
  const people = clientSection(client, extras.visits);
  const style = styleSection(snapshot);
  const note = noteSection(booking);
  const look = [style.lead, ...style.lines.map((l) => l.text)].join(', ');
  const origin =
    booking.createdAt &&
    `${booking.source === 'admin' ? 'Added by the studio' : 'Booked online'} ${et(booking.createdAt, STAMP)} Eastern.`;
  const footer = [`Booking code ${oneLine(booking.ref)}.`, origin]
    .filter(Boolean)
    .join(' ');
  if (kind.startsWith('payment_review')) {
    const ended = kind === 'payment_review_expired';
    const prefix =
      {
        payment_review_reminder: 'Reminder: ',
        payment_review_urgent: 'Urgent: ',
      }[kind] || '';
    const extendable =
      !extras.extended &&
      booking.holdExpiresAt &&
      booking.holdExpiresAt < booking.startAt;
    const method = methods[proof.method] || 'payment';
    const balance = proof.paymentType === 'balance';
    const deadline =
      !balance && booking.status === 'pending_payment' && booking.holdExpiresAt;
    const total = booking.subtotalCents ?? snapshot.subtotalCents ?? 0;
    const after = balance
      ? Math.max(0, booking.balanceCents - proof.amountCents)
      : Math.max(0, total - proof.amountCents);
    return {
      subject: ended
        ? `Hold ended: check ${method} for ${name}, ${usd(proof.amountCents)}`
        : prefix +
          (prefix
            ? `review ${method} payment: ${name}, ${usd(proof.amountCents)}`
            : `Review ${method} payment: ${name}, ${usd(proof.amountCents)}`),
      preview: ended
        ? 'Not reviewed in time. The chair has been released.'
        : deadline
          ? `Not confirmed yet. Chair held until ${et(booking.holdExpiresAt, SHORT)}`
          : `${balance ? 'Balance payment' : 'Payment'} for ${when}`,
      badge: ended
        ? 'Hold ended'
        : prefix
          ? prefix.slice(0, -2)
          : 'Review payment',
      tone: amber,
      kicker: ended
        ? 'The chair has been released'
        : balance
          ? 'Balance payment not recorded yet'
          : 'Not confirmed yet',
      heading: `Check your ${method} for ${usd(proof.amountCents)}`,
      subheading: deadline
        ? `Review by ${et(booking.holdExpiresAt, STAMP)} Eastern`
        : '',
      intro: ended
        ? 'This payment was not reviewed in time. Check whether the money arrived, then call the client. You can still approve it if the time is free.'
        : (kind === 'payment_review_urgent'
            ? 'This payment was not reviewed in time, so the chair is being held a little longer. '
            : 'The client uploaded a payment screenshot. ') +
          'Make sure the money reached your account before you approve.' +
          (!deadline
            ? ''
            : extendable
              ? ' If you don’t review it by then, the hold is extended once by up to 24 hours.'
              : ' The chair is released if you don’t review it by then.'),
      sections: [
        {
          title: 'Payment',
          rows: [
            { label: 'Method', value: method, strong: true },
            {
              label: 'Total',
              value: snapshot.consultation
                ? 'Agreed at consultation'
                : usd(total),
              wrap: Boolean(snapshot.consultation),
            },
            {
              label: balance
                ? 'Balance to verify'
                : proof.paymentType === 'full'
                  ? 'Full payment to verify'
                  : 'Deposit to verify',
              value: usd(proof.amountCents),
              strong: true,
              color: WARN,
            },
            {
              label: 'Balance after approval',
              value: snapshot.consultation
                ? 'Agreed at consultation'
                : usd(after),
              wrap: Boolean(snapshot.consultation),
              total: true,
            },
          ],
        },
        {
          title: balance ? 'Appointment' : 'Requested appointment',
          lead: et(booking.startAt, LONG),
          lines: [{ text: time(booking) }],
        },
        people,
        style,
        note,
      ].filter(Boolean),
      actions: (ended
        ? [call, { label: 'Open booking', href: portal }]
        : [{ label: 'Review payment', href: portal }, call]
      ).filter(Boolean),
      footer:
        'Sign in to see the screenshot and approve or reject it. ' + footer,
    };
  }
  const copy = {
    booking_confirmed: ['New booking', 'Confirmed', violet],
    booking_rescheduled: ['Rescheduled', 'New date and time', violet],
    booking_cancelled: ['Cancelled', 'This appointment is cancelled', amber],
  }[kind];
  const pay = paymentSection(booking, snapshot, extras.payments, true);
  const reason = oneLine(booking.cancelReason);
  return {
    subject: `${copy[0]}: ${name}, ${when}`,
    preview: [
      look,
      `paid ${usd(booking.paidCents)}`,
      kind !== 'booking_cancelled' &&
        !snapshot.consultation &&
        `balance ${usd(Math.max(0, booking.balanceCents))}`,
    ]
      .filter(Boolean)
      .join(', '),
    badge: copy[0],
    tone: copy[2],
    kicker: copy[1],
    heading: et(booking.startAt, LONG),
    subheading: time(booking),
    intro: '',
    sections: [
      people,
      style,
      pay,
      kind === 'booking_cancelled' && reason
        ? { title: 'Reason', note: reason }
        : null,
      note,
    ].filter(Boolean),
    actions: [call, { label: 'Open booking', href: portal }].filter(Boolean),
    footer,
  };
}

const customer = {
  'booking-confirmation': { badge: 'Confirmed', prep: true, where: true },
  'payment-submitted': { badge: 'Awaiting verification', tone: amber },
  'payment-rejected': { badge: 'Not verified', tone: amber },
  'payment-review-expired': { badge: 'Hold ended', tone: amber },
  'booking-rescheduled': { badge: 'Rescheduled', prep: true, where: true },
  'reminder-48': { badge: 'Reminder', prep: true, where: true },
  'reminder-morning': { badge: 'Today', prep: true, where: true },
  'booking-cancelled': { badge: 'Cancelled', tone: amber },
  'payment-conflict': { badge: 'Action needed', tone: amber },
  'refund-receipt': { badge: 'Refund' },
  'balance-receipt': { badge: 'Receipt' },
  'payment-receipt': { badge: 'Receipt' },
  'deposit-payment': { badge: 'Payment due', tone: amber, where: true },
  'balance-payment': { badge: 'Payment due', tone: amber, where: true },
  'thank-you': { badge: 'Thank you', noPayment: true },
};
const dated = new Set([
  'booking-confirmation',
  'booking-rescheduled',
  'booking-cancelled',
  'reminder-48',
  'reminder-morning',
]);
const kickers = {
  'booking-confirmation': 'your chair is booked',
  'booking-rescheduled': 'your appointment has changed',
  'booking-cancelled': 'your appointment is cancelled',
  'thank-you': 'thank you for visiting',
};

export function customerBookingMail(
  template,
  { booking, client },
  extras = {},
  {
    subject,
    intro,
    customSubject,
    action,
    business,
    settings,
    directions,
    bookUrl,
    payUrl,
  },
  payload = {},
) {
  const kind = customer[template];
  if (!kind) return null;
  const snapshot = booking.priceSnapshot || {};
  const policy = { ...publicSettings.policy, ...settings.policy };
  const reminder = template.startsWith('reminder-');
  const online =
    settings.balanceOptions?.online !== false &&
    booking.balanceCents > 0 &&
    !snapshot.consultation &&
    booking.paymentStatus === 'deposit_paid';
  const when = dayLabel(booking.startAt, extras.now || new Date());
  const prep = [];
  if (kind.prep) {
    if (!(snapshot.addons || []).some((a) => /head wash/i.test(a.name)))
      prep.push('Arrive with your hair washed and detangled.');
    if (reminder && booking.balanceCents > 0 && !snapshot.consultation)
      prep.push(
        online
          ? {
              before: `Have your ${usd(booking.balanceCents)} balance ready, or `,
              text: 'pay it online',
              href: payUrl,
              after: ' before you arrive.',
            }
          : `Have your ${usd(booking.balanceCents)} balance ready.`,
      );
    prep.push(
      'Tell us about any allergies or recent scalp or hair treatments, and bring along your own hair products.',
    );
    prep.push(
      `Running late? Please call us. Arriving more than ${policy.lateFeeMinutes} minutes late has a late fee${policy.lateFeeCents ? ' of ' + usd(policy.lateFeeCents) : ''}.`,
    );
    if (reminder)
      prep.push(
        policy.freeReschedules > 0 && when !== 'today'
          ? `Can’t make it? Call us as soon as possible. Free rescheduling needs at least ${policy.rescheduleHours} hours of notice.`
          : 'Can’t make it? Call us as soon as possible.',
      );
    else
      prep.push(
        policy.freeReschedules > 0
          ? `Need another time? ${policy.freeReschedules === 1 ? 'One free reschedule' : `${policy.freeReschedules} free reschedules`} with at least ${policy.rescheduleHours} hours of notice. Call to request it.`
          : 'Need another time? Call us to ask about a change.',
      );
    if (booking.paidCents > 0 && !reminder)
      prep.push(
        policy.depositRefundable
          ? 'Your deposit goes toward your total.'
          : 'Your deposit goes toward your total and is non-refundable if you cancel.',
      );
  }
  const name = firstName(client);
  const call = { label: 'Call the studio', href: 'tel:' + business.phone };
  const lapsed = template === 'payment-review-expired';
  const rejected = template === 'payment-rejected' || lapsed;
  const line = reminder
    ? when === 'today'
      ? 'see you today'
      : `your appointment is ${when}`
    : kickers[template];
  let message = intro;
  if (template === 'booking-confirmation')
    message += ' A calendar file is attached so you can save the date.';
  const submitted = template === 'payment-submitted' && extras.proof;
  if (submitted && submitted.paymentType !== 'balance')
    message += ` Your booking is not confirmed yet.${booking.holdExpiresAt ? ` Your chair is held until ${et(booking.holdExpiresAt, STAMP)} Eastern.` : ''}`;
  if (rejected && !lapsed)
    message +=
      payload.paymentType === 'balance'
        ? ' Your appointment is still confirmed and your balance remains due.'
        : ' Your appointment is not confirmed and the time we held for you has been released.';
  if (template === 'payment-conflict')
    message +=
      booking.paymentStatus === 'refunded'
        ? ' Refund recorded.'
        : ' Refund is processing.';
  if (
    template === 'deposit-payment' &&
    booking.status === 'pending_payment' &&
    booking.holdExpiresAt
  )
    message += ` Your chair is held until ${et(booking.holdExpiresAt, STAMP)} Eastern.`;
  const style = styleSection(snapshot, 'Your style');
  return {
    subject:
      reminder && !customSubject
        ? when === 'today'
          ? `See you today at ${et(booking.startAt, 'h:mm a')}`
          : `Your appointment is ${when}: ${et(booking.startAt, SHORT)}`
        : dated.has(template) && !customSubject
          ? `${subject}: ${et(booking.startAt, SHORT)}`
          : subject,
    preview: dated.has(template)
      ? [
          style.lead,
          ...style.lines.map((l) => l.text),
          kind.where && business.street,
        ]
          .filter(Boolean)
          .join(', ')
      : intro,
    badge: kind.badge,
    tone: kind.tone || violet,
    kicker:
      customSubject || !line ? subject : cap(name ? `${name}, ${line}` : line),
    heading: et(booking.startAt, LONG),
    subheading: time(booking),
    intro: message,
    sections: [
      style,
      rejected && rejectedSection(booking, snapshot, payload),
      submitted && submittedSection(booking, snapshot, submitted),
      !kind.noPayment &&
        !submitted &&
        !rejected &&
        paymentSection(
          booking,
          snapshot,
          extras.payments,
          false,
          template === 'refund-receipt' ? payload.amountCents : undefined,
        ),
      kind.where && {
        title: 'Where to find us',
        lead: business.street,
        lines: [
          {
            text: `${business.city}, ${business.region} ${business.postalCode}`,
          },
          { text: 'Get directions', href: directions },
        ],
      },
      prep.length && { title: 'Before you come', items: prep },
    ].filter(Boolean),
    actions: rejected
      ? [
          call,
          payload.paymentType === 'balance'
            ? action
            : { label: 'Book another time', href: bookUrl },
        ]
      : [
          reminder && online
            ? { ...action, label: 'View visit & pay balance' }
            : action,
          call,
        ],
    footer: `Booking code ${oneLine(booking.ref)}. Keep it to find your booking. Questions? Reply to this email or call the studio.`,
  };
}

export function bookingMailText(mail) {
  const out = [mail.subject, '', mail.kicker, mail.heading, mail.subheading];
  if (mail.intro) out.push('', mail.intro);
  for (const s of mail.sections) {
    out.push('', s.title.toUpperCase());
    if (s.lead) out.push(s.lead);
    for (const l of s.lines || [])
      out.push(l.href?.startsWith('http') ? `${l.text}: ${l.href}` : l.text);
    for (const r of s.rows || []) out.push(`${r.label}: ${r.value}`);
    if (s.note) out.push(s.note);
    if (s.after) out.push(s.after);
    for (const i of s.items || [])
      out.push(
        '- ' + (i.href ? `${i.before}${i.text} (${i.href})${i.after}` : i),
      );
  }
  out.push('');
  for (const a of mail.actions)
    out.push(`${a.label}: ${a.href.replace(/^tel:/, '')}`);
  out.push('', mail.footer);
  return out.join('\n');
}
