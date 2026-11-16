import { DateTime } from 'luxon';
import { BookingError } from './bookingErrors.js';

export const ZONE = 'America/New_York';
const millis = (value) =>
  value instanceof Date
    ? value.getTime()
    : DateTime.fromISO(value, { zone: 'utc' }).toMillis();
export function blocksCapacity(row, now) {
  return (
    ['confirmed', 'completed'].includes(row.status) ||
    (row.status === 'pending_payment' &&
      millis(row.holdExpiresAt) > now.toMillis())
  );
}
export function remainingCapacity(start, end, rows, capacity, now) {
  const events = [];
  for (const row of rows) {
    if (!blocksCapacity(row, now)) continue;
    const a = Math.max(start.toMillis(), millis(row.startAt));
    const b = Math.min(end.toMillis(), millis(row.blockEndAt));
    if (a < b) events.push([a, 1], [b, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0,
    peak = 0;
  for (const [, delta] of events) {
    count += delta;
    peak = Math.max(peak, count);
  }
  return Math.max(0, capacity - peak);
}
export function localDay(date) {
  const day = DateTime.fromISO(date, { zone: ZONE });
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !day.isValid ||
    day.toISODate() !== date
  )
    throw new BookingError('INVALID_DATE', 'Choose a valid date.');
  return day.startOf('day');
}
export function daySlots({
  date,
  durationMin,
  settings,
  bookings = [],
  timeBlocks = [],
  now = DateTime.utc(),
}) {
  const day = localDay(date);
  const config = settings.booking;
  const hours = settings.hours.weekly[day.toFormat('cccc').toLowerCase()];
  if (!hours || hours.closed) return [];
  if (
    !Number.isInteger(config.capacity) ||
    config.capacity < 1 ||
    !Number.isInteger(config.stepMinutes) ||
    config.stepMinutes < 1
  )
    throw new BookingError(
      'INVALID_SETTINGS',
      'Please call the studio to arrange your visit.',
      503,
    );
  const open = DateTime.fromISO(`${date}T${hours.open}`, { zone: ZONE });
  const close = DateTime.fromISO(`${date}T${hours.close}`, { zone: ZONE });
  if (!open.isValid || !close.isValid || close <= open) return [];
  const earliest = now.plus({ hours: config.minNoticeHours });
  const latest = now.setZone(ZONE).plus({ days: config.maxAdvanceDays });
  const result = [];
  // Iterate instants, not naive wall-clock strings: DST gaps never become slots.
  for (
    let start = open;
    start < close;
    start = start.plus({ minutes: config.stepMinutes })
  ) {
    const end = start.plus({ minutes: durationMin });
    const blockEnd = end.plus({ minutes: config.bufferMinutes });
    if (blockEnd > close || start < earliest || start > latest) continue;
    const blocked = timeBlocks.some(
      (b) =>
        millis(b.startAt) < blockEnd.toMillis() &&
        millis(b.endAt) > start.toMillis(),
    );
    const remaining = blocked
      ? 0
      : remainingCapacity(start, blockEnd, bookings, config.capacity, now);
    result.push({
      startAt: start.toUTC().toISO(),
      endAt: end.toUTC().toISO(),
      blockEndAt: blockEnd.toUTC().toISO(),
      label: `${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a')}`,
      remaining,
      available: remaining > 0,
    });
  }
  return result;
}
export function createAvailabilityService(
  repository,
  clock = () => DateTime.utc(),
) {
  async function day(selection, date) {
    const { priceBooking } = await import('./pricingService.js');
    const catalog = await repository.catalog();
    const price = priceBooking(catalog, selection);
    const start = localDay(date),
      end = start.plus({ days: 1 });
    const schedule = await repository.schedule(
      start.toJSDate(),
      end.toJSDate(),
    );
    return {
      date,
      timezone: ZONE,
      slots: daySlots({
        date,
        durationMin: price.durationMin,
        settings: catalog.settings,
        ...schedule,
        now: clock(),
      }),
    };
  }
  async function month(selection, month) {
    const first = localDay(`${month}-01`);
    const { priceBooking } = await import('./pricingService.js');
    const catalog = await repository.catalog();
    const price = priceBooking(catalog, selection);
    const schedule = await repository.schedule(
      first.toJSDate(),
      first.plus({ months: 1 }).toJSDate(),
    );
    return {
      month,
      timezone: ZONE,
      days: Array.from({ length: first.daysInMonth }, (_, i) => {
        const date = first.plus({ days: i }).toISODate();
        return {
          date,
          available: daySlots({
            date,
            durationMin: price.durationMin,
            settings: catalog.settings,
            ...schedule,
            now: clock(),
          }).some((s) => s.available),
        };
      }),
    };
  }
  return { day, month };
}
