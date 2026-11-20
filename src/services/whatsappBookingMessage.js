import { DateTime } from 'luxon';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
const oneLine = (value) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
const money = (cents) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
function ordinal(value) {
  const lastTwo = value % 100;
  return (
    value +
    (lastTwo >= 11 && lastTwo <= 13
      ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[value % 10] || 'th')
  );
}
export function whatsappBookingMessage(
  { booking, client },
  previousCompletedVisits = 0,
  review = false,
) {
  const price =
    typeof booking.priceSnapshot === 'string'
      ? JSON.parse(booking.priceSnapshot)
      : booking.priceSnapshot || {};
  const size =
    { medium: 'Medium', semi_medium: 'Semi-medium', small: 'Small' }[
      price.size
    ] || '';
  const length =
    {
      shoulder: 'Shoulder',
      mid_back: 'Mid-back',
      waist: 'Waist',
      top_butt: 'Top butt',
      butt: 'Butt',
      under_butt: 'Under butt',
    }[price.length] || '';
  const phone = parsePhoneNumberFromString(client.phoneE164 || '');
  const displayPhone = phone
    ? phone.country === 'US'
      ? phone.formatNational()
      : phone.formatInternational()
    : oneLine(client.phoneE164);
  const date = DateTime.fromJSDate(new Date(booking.startAt), {
    zone: 'America/New_York',
  })
    .setLocale('en-US')
    .toFormat("cccc, LLLL d, yyyy 'at' h:mm a ZZZZ");
  return [
    `${review ? '🕓 PAYMENT REVIEW' : '💰 NEW BOOKING'} — Mado African Braids`,
    `👤 ${oneLine(client.name)} · ${displayPhone}`,
    previousCompletedVisits > 0
      ? `⭐ Returning client — ${ordinal(previousCompletedVisits + 1)} visit`
      : '⭐ First recorded visit',
    `💇🏾‍♀️ ${[size, oneLine(price.styleName) || 'Booked hairstyle'].filter(Boolean).join(' ')}${length ? ' (' + length + ')' : ''}`,
    `📅 ${date}`,
    `💵 Paid ${money(booking.paidCents)} · Balance ${money(booking.balanceCents)}`,
    `🔖 Code ${oneLine(booking.ref)}`,
    ...(review ? ['⚠️ Payment proof awaiting owner approval'] : []),
  ].join('\n');
}
