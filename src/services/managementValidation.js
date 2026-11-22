import { ManagementError } from './managementErrors.js';
import { z } from 'zod';
import { DateTime } from 'luxon';
export const entityId = z.coerce.number().int().positive().safe();
export function durationFromHours(body) {
  if (body.durationHours === undefined) return body;
  const value = body.durationHours;
  const minutes =
    value === ''
      ? ''
      : z.coerce
          .number()
          .finite()
          .min(0.5)
          .max(15)
          .transform((hours) => hours * 60)
          .refine(
            (n) => Math.abs(n - Math.round(n)) < 0.000001,
            'Enter a duration in whole minutes',
          )
          .transform(Math.round)
          .parse(value);
  return { ...body, durationMin: minutes };
}
export const checked = z.preprocess(
  (v) => [true, 'true', 'on', '1'].includes(v),
  z.boolean(),
);
const text = (n = 255) => z.string().trim().max(n).default('');
export const dollars = z
  .string()
  .trim()
  .regex(/^\d{1,6}(?:\.\d{1,2})?$/, 'Enter a valid USD amount')
  .transform((v) => {
    const [a, b = ''] = v.split('.');
    return Number(a) * 100 + Number(b.padEnd(2, '0'));
  });
const optionalDollars = z
  .union([z.literal('').transform(() => null), dollars])
  .default('');
export const styleInput = z.object({
  name: text().refine(Boolean, 'Name is required'),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(180),
  categoryId: entityId,
  shortDesc: text(1000),
  longDesc: text(20000),
  durationMin: z.coerce.number().int().min(30).max(900),
  priceOnConsultation: checked,
  fromPrice: optionalDollars,
  featured: checked,
  active: checked,
  seoTitle: text(),
  seoDescription: text(500),
});
export const variantInput = z.object({
  size: z
    .enum(['', 'medium', 'semi_medium', 'small'])
    .transform((v) => v || null),
  length: z
    .enum([
      '',
      'shoulder',
      'mid_back',
      'waist',
      'top_butt',
      'butt',
      'under_butt',
    ])
    .transform((v) => v || null),
  label: text(),
  price: dollars.refine((value) => value >= 50, 'Price must be at least $0.50'),
  durationMin: z.preprocess(
    (v) => (v === '' ? null : v),
    z.coerce.number().int().min(30).max(900).nullable(),
  ),
  active: checked,
});
export const addonInput = z.object({
  name: text().refine(Boolean, 'Name is required'),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(180),
  description: text(2000),
  price: dollars,
  durationMin: z.coerce.number().int().min(0).max(360),
  active: checked,
  appliesToAll: checked,
  sort: z.coerce.number().int().min(0).max(9999).default(0),
  styleIds: z.preprocess(
    (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]),
    z.array(entityId).max(100),
  ),
});
export const publicPath = z
  .string()
  .max(512)
  .regex(/^\/(?:[a-z0-9-]+\/?)*$/)
  .refine(
    (v) => !/^\/(?:admin|api|booking|book|pay|webhooks|health)(?:\/|$)/.test(v),
    'Use a public content page path',
  );
export const redirectInput = z
  .object({ source: publicPath, target: publicPath })
  .refine(
    (v) => v.source !== v.target,
    'A redirect must lead to a different page',
  );
export const weekdays = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
export function availabilityInput(raw) {
  const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
  const weekly = Object.fromEntries(
    weekdays.map((day) => {
      const open = time.parse(raw[day + 'Open']),
        close = time.parse(raw[day + 'Close']),
        closed = checked.parse(raw[day + 'Closed']);
      if (!closed && open >= close)
        throw new ManagementError('Closing time must be after opening time');
      return [day, { open, close, closed }];
    }),
  );
  return {
    weekly,
    booking: z
      .object({
        stepMinutes: z.literal(30).default(30),
        capacity: z.literal(3).default(3),
        bufferMinutes: z.coerce.number().int().min(0).max(180),
        minNoticeHours: z.coerce.number().int().min(0).max(168),
        maxAdvanceDays: z.coerce.number().int().min(1).max(365),
      })
      .parse(raw),
  };
}
export function blockOccurrences(raw) {
  const v = z
    .object({
      date: z.iso.date(),
      start: z.string().regex(/^\d\d:\d\d$/),
      end: z.string().regex(/^\d\d:\d\d$/),
      reason: text(500),
      repeat: z.enum(['once', 'weekly']),
      until: z.string().default(''),
    })
    .parse(raw);
  const start = DateTime.fromISO(v.date + 'T' + v.start, {
      zone: 'America/New_York',
    }),
    end = DateTime.fromISO(v.date + 'T' + v.end, { zone: 'America/New_York' });
  if (
    !start.isValid ||
    !end.isValid ||
    start.toFormat('HH:mm') !== v.start ||
    end.toFormat('HH:mm') !== v.end ||
    end <= start
  )
    throw new ManagementError('Choose a valid start and end time');
  const until =
    v.repeat === 'weekly'
      ? DateTime.fromISO(v.until, { zone: 'America/New_York' }).endOf('day')
      : end;
  if (!until.isValid || until < end || until > start.plus({ days: 365 }))
    throw new ManagementError('Choose a repeat end date within one year');
  const rows = [];
  for (let a = start; a <= until; a = a.plus({ weeks: 1 })) {
    const b = a.set({ hour: end.hour, minute: end.minute });
    if (a.toFormat('HH:mm') !== v.start || b.toFormat('HH:mm') !== v.end)
      throw new ManagementError(
        'A repeated time falls in a daylight-saving gap',
      );
    rows.push({
      startAt: a.toUTC().toJSDate(),
      endAt: b.toUTC().toJSDate(),
      reason: v.reason,
    });
    if (v.repeat === 'once') break;
  }
  return rows;
}
