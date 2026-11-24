import { DateTime } from 'luxon';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

const ZONE = 'America/New_York';
export const money = (cents) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
export const statusLabels = {
  pending_payment: 'Awaiting payment',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
  expired: 'Expired',
  payment_conflict: 'Payment conflict',
};
const et = (value, format) =>
  DateTime.fromJSDate(value, { zone: ZONE }).toFormat(format);

export function phoneLabel(value) {
  const phone = parsePhoneNumberFromString(String(value || ''));
  if (!phone) return value;
  return phone.country === 'US'
    ? phone.formatNational()
    : phone.formatInternational();
}
// An ended hold no longer keeps a chair, unless its transfer still needs review.
export function showOnCalendar({ booking, paymentReview }, now) {
  return (
    booking.status !== 'pending_payment' ||
    paymentReview ||
    booking.holdExpiresAt > now
  );
}
export function calendarBooking(row) {
  const { booking: b, client: c } = row;
  const open = ['pending_payment', 'confirmed', 'completed'].includes(b.status);
  const initialReview = row.paymentReview && b.status === 'pending_payment';
  return {
    id: String(b.id),
    title: `${c.name} · ${row.styleName}`,
    start: b.startAt.toISOString(),
    end: b.endAt.toISOString(),
    url: `/admin/bookings/${b.id}`,
    editable: ['confirmed', 'pending_payment'].includes(b.status),
    classNames: [`status-${initialReview ? 'review' : b.status}`],
    extendedProps: {
      status: b.status,
      statusLabel: initialReview
        ? 'Payment to review'
        : row.paymentReview
          ? 'Balance payment to review'
          : statusLabels[b.status],
      review: row.paymentReview,
      updatedAt: b.updatedAt.toISOString(),
      name: c.name,
      style: [
        row.styleName,
        row.styleOption === 'Standard service' ? '' : row.styleOption,
      ]
        .filter(Boolean)
        .join(' · '),
      when: `${et(b.startAt, 'cccc, LLLL d · h:mm a')} – ${et(b.endAt, 'h:mm a')} ET`,
      phone: c.phoneE164 || '',
      phoneLabel: phoneLabel(c.phoneE164) || '',
      paid: money(b.paidCents),
      balance: money(b.balanceCents),
      source: row.paymentSource,
      open,
      owes: open && b.balanceCents > 0,
    },
  };
}
export function calendarBlock(block) {
  return {
    id: `block-${block.id}`,
    title: block.reason ? `Blocked · ${block.reason}` : 'Blocked time',
    start: new Date(block.startAt).toISOString(),
    end: new Date(block.endAt).toISOString(),
    editable: false,
    classNames: ['calendar-block'],
    extendedProps: { block: true },
  };
}
