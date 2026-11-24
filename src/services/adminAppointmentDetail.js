import { createHash } from 'node:crypto';
import { methodName } from './adminAppointment.js';

const emailNames = {
  'booking-confirmation': 'Booking confirmation',
  'booking-rescheduled': 'New date or time',
  'booking-cancelled': 'Cancellation',
  'deposit-payment': 'Deposit payment link',
  'balance-payment': 'Balance payment link',
  'balance-receipt': 'Balance receipt',
  'payment-receipt': 'Payment receipt',
  'payment-submitted': 'Payment screenshot received',
  'payment-rejected': 'Payment not received',
  'payment-review-expired': 'Hold ended before payment review',
  'payment-conflict': 'Payment conflict',
  'refund-receipt': 'Refund receipt',
  'reminder-48': 'Reminder before the visit',
  'reminder-morning': 'Reminder on the day',
  'admin-alert': 'Alert to the owner',
  'thank-you': 'Thank you after a visit',
  'winback-30': 'Come back, 30 days later',
  'winback-60': 'Come back, 60 days later',
  'winback-90': 'Come back, 90 days later',
  'contact-enquiry': 'Website message to the owner',
  'owner-test': 'Test email',
};
const actionNames = {
  create: 'Appointment created',
  edit: 'Appointment edited',
  confirm: 'Confirmed without payment',
  cancel: 'Appointment cancelled',
  complete: 'Marked completed',
  'no-show': 'Marked no-show',
  payment: 'Payment recorded',
  refund: 'Refund requested',
  note: 'Private note saved',
  'balance-link': 'Balance payment link requested',
  resend: 'Confirmation email requested',
};
const titled = (value) => {
  const text = String(value || '').replace(/[-_]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};
export const emailName = (template) =>
  emailNames[template] || titled(template) || 'Email';

// The same rules the booking service enforces, so the page only offers actions
// that can succeed. The service still has the final say.
export function appointmentActions({
  booking,
  payments = [],
  proofs = [],
  attempts = [],
  refundJobs = [],
  consultation = false,
  now = new Date(),
}) {
  const pending = booking.status === 'pending_payment';
  const confirmed = booking.status === 'confirmed';
  const holdLive = pending && booking.holdExpiresAt > now;
  const started = booking.startAt <= now;
  const blocked = proofs.some((p) => p.status === 'pending')
    ? 'Review the payment above first. Other changes unlock afterwards.'
    : attempts.some((a) => ['creating', 'open'].includes(a.status))
      ? 'The client has a card payment open. Changes unlock when it finishes or closes.'
      : refundJobs.some((j) => ['pending', 'failed'].includes(j.status))
        ? 'A refund is still being processed. Changes unlock when it finishes.'
        : '';
  const free = !blocked;
  const refunds = payments.filter((p) => p.type === 'refund');
  const refundable = payments
    .filter((p) => p.type !== 'refund')
    .map((p) => ({
      ...p,
      remainingCents:
        p.amountCents -
        refunds
          .filter((r) =>
            p.provider === 'stripe'
              ? r.stripePaymentIntentId === p.stripePaymentIntentId
              : r.note?.startsWith(`Refund of payment ${p.id}.`),
          )
          .reduce((sum, r) => sum + r.amountCents, 0),
    }))
    .filter((p) => p.remainingCents > 0);
  const kept = confirmed || booking.status === 'completed';
  return {
    blocked,
    holdLive,
    edit: free && (confirmed || holdLive),
    confirm: free && holdLive,
    complete: free && confirmed && started,
    noShow: free && confirmed && started,
    cancel: free && (confirmed || pending),
    payment: free && booking.balanceCents > 0 && (kept || holdLive),
    refundable: free ? refundable : [],
    balanceLink: kept && booking.balanceCents > 0 && !consultation,
    resend: confirmed,
  };
}

// One newest-first story of the appointment.
export function appointmentHistory({
  booking,
  payments = [],
  proofs = [],
  audits = [],
  emails = [],
  adminName = () => 'Owner',
  money,
}) {
  const created = audits.some((a) => a.action === 'create');
  const items = [
    ...(created
      ? []
      : [
          {
            at: booking.createdAt,
            title:
              booking.source === 'admin'
                ? 'Booked by the studio'
                : 'Booked on the website',
            kind: 'booking',
          },
        ]),
    ...payments
      .filter((p) => !p.adminRequestKey)
      .map((p) => ({
        at: p.createdAt,
        kind: 'payment',
        title: `${p.type === 'refund' ? 'Refund' : titled(p.type) + ' payment'} of ${money(p.amountCents)}`,
        by: methodName(p.method),
      })),
    ...proofs.map((p) => ({
      at: p.createdAt,
      kind: 'payment',
      title: `${methodName(p.method)} screenshot received for ${money(p.amountCents)}`,
      by: p.status === 'pending' ? 'Awaiting review' : titled(p.status),
    })),
    ...audits.map((a) => ({
      at: a.createdAt,
      kind: 'owner',
      title: actionNames[a.action] || titled(a.action),
      by: adminName(a.adminId),
      changes:
        a.action === 'create'
          ? []
          : (a.changes || []).filter(
              (c) => a.action !== 'note' || c.label !== 'Reason / note',
            ),
    })),
    ...emails.map((e) => ({
      at: e.createdAt,
      kind: 'email',
      title: `Email: ${emailName(e.template)}`,
      by: titled(e.status),
    })),
  ];
  return items
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at));
}

// Changes whenever anything shown on the page changes.
export function appointmentVersion(data) {
  return createHash('sha1')
    .update(
      JSON.stringify([
        data.booking.updatedAt,
        data.booking.status,
        data.booking.paidCents,
        data.payments.map((p) => p.id),
        data.proofs.map((p) => [p.id, p.status]),
        data.emails.map((e) => [e.id, e.status]),
        data.audits.length,
        data.refundJobs.map((j) => [j.id, j.status]),
        data.actions.blocked,
        data.actions.complete,
        data.actions.holdLive,
      ]),
    )
    .digest('hex')
    .slice(0, 16);
}
