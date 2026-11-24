import { DateTime } from 'luxon';

const ZONE = 'America/New_York';
export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
export const clockLabel = (time) =>
  DateTime.fromISO('2026-01-01T' + time).toFormat('h:mm a');
export const rangeLabel = (day) =>
  !day || day.closed
    ? 'Closed'
    : `${clockLabel(day.open)}–${clockLabel(day.close)}`;

// A special day (a holiday, a short day) wins over the normal week.
export function hoursOn(hours, date) {
  const special = (hours?.special || []).find((item) => item.date === date);
  if (special) return { ...special, special: true };
  const day = DateTime.fromISO(date, { zone: ZONE });
  return hours?.weekly?.[day.toFormat('cccc').toLowerCase()] || null;
}
// "Mon–Sat" style groups of neighbouring days with the same hours.
export function weekGroups(weekly) {
  const groups = [];
  for (const day of WEEKDAYS) {
    const text = rangeLabel(weekly[day]);
    const short = day[0].toUpperCase() + day.slice(1, 3);
    const last = groups.at(-1);
    if (last?.text === text) last.to = short;
    else groups.push({ from: short, to: short, text });
  }
  return groups.map(({ from, to, text }) => ({
    days: from === to ? from : `${from}–${to}`,
    text,
  }));
}
export function weekSummary(weekly) {
  return weekGroups(weekly)
    .map((group) => `${group.days} · ${group.text}`)
    .join('; ');
}
// What the website header, footer and contact page show.
export function publicHours(hours, now = DateTime.now()) {
  const today = now.setZone(ZONE);
  let shown = hours;
  if (hours?.customHours && hours.weekly) {
    const [first, ...rest] = weekGroups(hours.weekly);
    shown = {
      ...hours,
      summary: weekSummary(hours.weekly),
      description: weekSummary(hours.weekly),
      daysLabel: first.days,
      timeLabel: first.text,
      sundayLabel: rest.length
        ? rest.map((group) => `${group.days} · ${group.text}`).join('; ')
        : 'Eastern time',
    };
  }
  const limit = today.plus({ days: 45 }).toISODate();
  const specialDays = (hours?.special || [])
    .filter((item) => item.date >= today.toISODate() && item.date <= limit)
    .map((item) => ({
      ...item,
      label: DateTime.fromISO(item.date).toFormat('cccc, LLLL d'),
      text: rangeLabel(item),
    }));
  if (specialDays[0]?.date === today.toISODate())
    shown = {
      ...shown,
      daysLabel: 'Today',
      timeLabel:
        specialDays[0].text +
        (specialDays[0].note ? ` (${specialDays[0].note})` : ''),
    };
  return shown ? { ...shown, specialDays } : shown;
}
// Appointments that would fall outside the hours on their day.
export function outsideHours(bookings, hours) {
  return bookings.filter((booking) => {
    const start = DateTime.fromJSDate(booking.startAt, { zone: ZONE });
    const end = DateTime.fromJSDate(booking.endAt, { zone: ZONE });
    const day = hoursOn(hours, start.toISODate());
    if (!day || day.closed) return true;
    return (
      start.toFormat('HH:mm') < day.open ||
      end.toISODate() !== start.toISODate() ||
      end.toFormat('HH:mm') > day.close
    );
  });
}
// Shades for the owner calendar: closed days and the closed part of short days.
export function specialShades(hours, start, end) {
  const shades = [];
  for (const item of hours?.special || []) {
    const day = DateTime.fromISO(item.date, { zone: ZONE });
    if (day.toJSDate() >= end || day.plus({ days: 1 }).toJSDate() <= start)
      continue;
    const at = (time) =>
      DateTime.fromISO(`${item.date}T${time}`, { zone: ZONE }).toJSDate();
    const title = item.note || 'Special day';
    const next = day.plus({ days: 1 }).toJSDate();
    if (item.closed)
      shades.push({
        startAt: day.toJSDate(),
        endAt: next,
        title: `Closed · ${title}`,
      });
    else
      shades.push(
        {
          startAt: day.toJSDate(),
          endAt: at(item.open),
          title: `Opens ${clockLabel(item.open)} · ${title}`,
        },
        {
          startAt: at(item.close),
          endAt: next,
          title: `Closes ${clockLabel(item.close)} · ${title}`,
        },
      );
  }
  return shades
    .filter((shade) => shade.endAt > shade.startAt)
    .map((shade, index) => ({ ...shade, id: `special-${index}` }));
}
