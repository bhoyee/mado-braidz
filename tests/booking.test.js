import { holdSchema } from '../src/routes/public/booking.js';
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { priceBooking } from '../src/services/pricingService.js';
import {
  daySlots,
  remainingCapacity,
  localDay,
  ZONE,
} from '../src/services/availabilityService.js';
import {
  assertTransition,
  createBookingService,
} from '../src/services/bookingService.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import { fixtureCatalog } from './fixtures/catalog.js';

describe('server pricing', () => {
  it('ignores client money and sums the two real extras, with a capped deposit', async () => {
    const repo = await memoryBookingRepository();
    const price = priceBooking(repo.data, {
      ...validHold,
      addonIds: [1, 2],
      priceCents: 1,
      subtotalCents: 1,
    });
    expect(price).toMatchObject({
      stylePriceCents: 18000,
      subtotalCents: 24500,
      depositCents: 3000,
      dueTodayCents: 3000,
      balanceAfterPaymentCents: 21500,
    });
    repo.data.styles[0].variants[0].priceCents = 1500;
    expect(priceBooking(repo.data, validHold).depositCents).toBe(1500);
  });
  it('uses variant and extra durations and rejects wrong, duplicate, inactive or ineligible choices', async () => {
    const repo = await memoryBookingRepository();
    expect(() =>
      priceBooking(repo.data, { ...validHold, styleVariantId: 201 }),
    ).toThrow();
    expect(() =>
      priceBooking(repo.data, { ...validHold, addonIds: [2, 2] }),
    ).toThrow();
    repo.data.addons[1].appliesToAll = false;
    repo.data.addons[1].styleIds = [2];
    expect(() =>
      priceBooking(repo.data, { ...validHold, addonIds: [2] }),
    ).toThrow();
    repo.data.addons[1].appliesToAll = true;
    repo.data.addons[1].durationMin = 20;
    repo.data.styles[0].variants[0].durationMin = 180;
    expect(
      priceBooking(repo.data, { ...validHold, addonIds: [2] }).durationMin,
    ).toBe(200);
    repo.data.styles[0].variants[0].active = false;
    expect(() => priceBooking(repo.data, validHold)).toThrow();
  });
  it('keeps consultation totals unknown and rejects full payment', async () => {
    const repo = await memoryBookingRepository();
    const style = repo.data.styles.find((s) => s.priceOnConsultation);
    const selection = {
      ...validHold,
      styleId: style.id,
      styleVariantId: undefined,
      addonIds: [2],
    };
    expect(priceBooking(repo.data, selection)).toMatchObject({
      consultation: true,
      stylePriceCents: null,
      balanceAfterPaymentCents: null,
      dueTodayCents: 3000,
      subtotalCents: 7000,
    });
    expect(() =>
      priceBooking(repo.data, { ...selection, paymentChoice: 'full' }),
    ).toThrow();
  });
});
describe('capacity over whole appointment intervals', () => {
  const dt = (s) => DateTime.fromISO(s, { zone: 'utc' });
  const row = (a, b, status = 'confirmed', holdExpiresAt = null) => ({
    startAt: dt(a).toJSDate(),
    blockEndAt: dt(b).toJSDate(),
    status,
    holdExpiresAt,
  });
  it('counts peak occupancy instead of the number of intersecting appointments', () => {
    const start = dt('2026-12-03T14:00Z'),
      end = start.plus({ hours: 4 });
    const rows = [
      row('2026-12-03T13:00Z', '2026-12-03T15:00Z'),
      row('2026-12-03T15:00Z', '2026-12-03T16:00Z'),
      row('2026-12-03T16:00Z', '2026-12-03T19:00Z'),
    ];
    expect(remainingCapacity(start, end, rows, 3, now)).toBe(2);
    rows.push(
      row('2026-12-03T14:30Z', '2026-12-03T17:00Z'),
      row('2026-12-03T15:30Z', '2026-12-03T16:30Z'),
    );
    expect(remainingCapacity(start, end, rows, 3, now)).toBe(0);
  });
  it('ignores expired holds and cancelled bookings, counts live holds and respects exact boundaries', () => {
    const start = dt('2026-12-03T14:00Z'),
      end = start.plus({ hours: 4 });
    const rows = [
      row('2026-12-03T13:00Z', '2026-12-03T14:00Z'),
      row('2026-12-03T14:00Z', '2026-12-03T19:00Z', 'cancelled'),
      row(
        '2026-12-03T14:00Z',
        '2026-12-03T19:00Z',
        'pending_payment',
        now.toJSDate(),
      ),
    ];
    expect(remainingCapacity(start, end, rows, 3, now)).toBe(3);
    rows.push(
      row(
        '2026-12-03T14:00Z',
        '2026-12-03T19:00Z',
        'pending_payment',
        now.plus({ minutes: 1 }).toJSDate(),
      ),
    );
    expect(remainingCapacity(start, end, rows, 3, now)).toBe(2);
  });
  it('enforces the confirmed half-hour starts, Sunday hours, buffer, blocks and notice', async () => {
    const repo = await memoryBookingRepository();
    const settings = repo.data.settings;
    const slots = daySlots({
      date: '2026-12-03',
      durationMin: 240,
      settings,
      now,
    });
    expect(
      DateTime.fromISO(slots[0].startAt).setZone(ZONE).toFormat('HH:mm'),
    ).toBe('06:00');
    expect(
      DateTime.fromISO(slots[1].startAt).diff(
        DateTime.fromISO(slots[0].startAt),
        'minutes',
      ).minutes,
    ).toBe(30);
    expect(
      DateTime.fromISO(slots.at(-1).startAt).setZone(ZONE).toFormat('HH:mm'),
    ).toBe('16:30');
    const sunday = daySlots({
      date: '2026-12-06',
      durationMin: 240,
      settings,
      now,
    });
    expect(
      DateTime.fromISO(sunday[0].startAt).setZone(ZONE).toFormat('HH:mm'),
    ).toBe('10:00');
    expect(
      DateTime.fromISO(sunday.at(-1).startAt).setZone(ZONE).toFormat('HH:mm'),
    ).toBe('13:30');
    expect(
      daySlots({ date: '2026-12-01', durationMin: 240, settings, now }),
    ).toEqual([]);
    expect(
      daySlots({ date: '2027-04-01', durationMin: 240, settings, now }),
    ).toEqual([]);
    settings.hours.weekly.thursday.closed = true;
    expect(
      daySlots({ date: '2026-12-03', durationMin: 240, settings, now }),
    ).toEqual([]);
    settings.hours.weekly.thursday.closed = false;
    const blocked = daySlots({
      date: '2026-12-03',
      durationMin: 240,
      settings,
      now,
      timeBlocks: [{ startAt: slots[0].startAt, endAt: slots[0].blockEndAt }],
    });
    expect(blocked[0].available).toBe(false);
    expect(blocked.find((s) => s.startAt === slots[9].startAt).available).toBe(
      true,
    );
    expect(() => localDay('2026-02-30')).toThrow();
  });
  it.each([
    ['2026-03-08', '-04:00'],
    ['2026-11-01', '-05:00'],
  ])('stores real UTC instants on DST date %s', async (date, offset) => {
    const repo = await memoryBookingRepository();
    repo.data.settings.booking.minNoticeHours = 0;
    const slots = daySlots({
      date,
      durationMin: 240,
      settings: repo.data.settings,
      now: DateTime.fromISO(date + 'T00:00Z'),
    });
    const first = DateTime.fromISO(slots[0].startAt).setZone(ZONE);
    expect(first.toFormat('HH:mm')).toBe('10:00');
    expect(first.toISO()).toContain(offset);
    expect(DateTime.fromISO(slots[0].endAt).diff(first, 'hours').hours).toBe(4);
  });
  it('skips nonexistent spring times and preserves both autumn instants if extended hours cross a clock change', async () => {
    const repo = await memoryBookingRepository();
    repo.data.settings.hours.weekly.sunday = {
      open: '00:00',
      close: '06:00',
      closed: false,
    };
    repo.data.settings.booking.minNoticeHours = 0;
    repo.data.settings.booking.bufferMinutes = 0;
    const spring = daySlots({
      date: '2026-03-08',
      durationMin: 30,
      settings: repo.data.settings,
      now: DateTime.fromISO('2026-03-08T00:00Z'),
    });
    expect(
      spring.some((s) => DateTime.fromISO(s.startAt).setZone(ZONE).hour === 2),
    ).toBe(false);
    const autumn = daySlots({
      date: '2026-11-01',
      durationMin: 30,
      settings: repo.data.settings,
      now: DateTime.fromISO('2026-11-01T00:00Z'),
    });
    expect(
      autumn.filter(
        (s) =>
          DateTime.fromISO(s.startAt).setZone(ZONE).toFormat('HH:mm') ===
          '01:30',
      ),
    ).toHaveLength(2);
  });
});
describe('booking service', () => {
  it.each([3, 1])(
    'allows only %i concurrent holds from 20 attempts',
    async (capacity) => {
      const repo = await memoryBookingRepository();
      repo.data.settings.booking.capacity = capacity;
      const service = createBookingService(repo, () => now);
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => service.createHold(validHold)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
        capacity,
      );
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .every((r) => r.reason.code === 'SLOT_TAKEN'),
      ).toBe(true);
      expect(repo.clients).toHaveLength(capacity);
      expect(
        repo.rows.every(
          (r) =>
            r.status === 'pending_payment' &&
            r.paidCents === 0 &&
            r.balanceCents === 18000,
        ),
      ).toBe(true);
    },
  );
  it('rejects off-grid starts and frees capacity when a hold expires', async () => {
    const repo = await memoryBookingRepository();
    repo.data.settings.booking.capacity = 1;
    let current = now;
    const service = createBookingService(repo, () => current);
    await expect(
      service.createHold({ ...validHold, startAt: '2026-12-03T14:15Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_START' });
    await service.createHold(validHold);
    current = now.plus({ minutes: 30 });
    await service.createHold(validHold);
    expect(repo.rows).toHaveLength(2);
    expect(() => assertTransition('cancelled', 'confirmed')).toThrow();
  });
});
describe('booking HTTP boundary', () => {
  async function setup(extra = {}) {
    const repo = await memoryBookingRepository();
    const dir = await mkdtemp(join(tmpdir(), 'mado-booking-test-'));
    const config = parseEnv({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test-secret-that-is-at-least-32-characters',
      DATABASE_URL: 'mysql://unused:unused@localhost/mado',
      UPLOAD_DIR: dir,
      ...extra,
    });
    const agent = request.agent(
      createApp({ config, catalog: fixtureCatalog(), bookingRepository: repo }),
    );
    const response = await agent.get('/book').expect(200);
    const csrf = response.text.match(/data-csrf="([^"]+)"/)[1];
    return { repo, agent, csrf, dir };
  }
  it('serves validated quotes and availability, rejects tampering and requires CSRF', async () => {
    const { agent, csrf, dir } = await setup();
    try {
      await agent
        .get('/api/bookings/quote?styleId=1&styleVariantId=101&addonIds=2')
        .expect(200)
        .expect((r) => expect(r.body.subtotalCents).toBe(22000));
      await agent
        .get('/api/bookings/quote?styleId=1&styleVariantId=101&priceCents=1')
        .expect(400);
      await agent
        .get('/api/availability/day?styleVariantId=101&date=2026-02-30')
        .expect(400);
      await agent
        .get('/api/availability?styleVariantId=101&month=2026-13')
        .expect(400);
      await agent
        .get('/api/availability?styleVariantId=101&month=2026-12')
        .expect(200)
        .expect((r) => expect(r.body.days).toHaveLength(31));
      await agent.post('/api/bookings/hold').send(validHold).expect(403);
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send({ ...validHold, phone: '+2348031234567' })
        .expect(400)
        .expect((r) => {
          expect(r.body.message).toBe('Invalid phone number');
          expect(r.body.fields).toContainEqual({
            field: 'phone',
            message: 'Invalid phone number',
          });
        });

      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send({ ...validHold, subtotalCents: 1 })
        .expect(400);
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send({ ...validHold, policyAccepted: false })
        .expect(400);
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send({ ...validHold, website: 'bot' })
        .expect(400);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('checks configured Turnstile server-side and rate limits hold attempts', async () => {
    const { agent, csrf, dir, repo } = await setup({
      TURNSTILE_SECRET_KEY: 'test-only-secret',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ json: async () => ({ success: false }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send({ ...validHold, turnstileToken: 'invalid' })
        .expect(400)
        .expect((r) => expect(r.body.error).toBe('VERIFICATION_FAILED'));
      expect(repo.rows).toHaveLength(0);
      expect(fetchMock).toHaveBeenCalledOnce();
      for (let i = 0; i < 9; i++)
        await agent
          .post('/api/bookings/hold')
          .set('x-csrf-token', csrf)
          .send({ ...validHold, policyAccepted: false })
          .expect(400);
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .send(validHold)
        .expect(429);
    } finally {
      vi.unstubAllGlobals();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('creates a private re-encoded image, rejects fake images and cleans failed holds', async () => {
    const { agent, csrf, dir, repo } = await setup();
    try {
      const input = {
        ...validHold,
        startAt: DateTime.now()
          .setZone(ZONE)
          .plus({ days: 2 })
          .startOf('day')
          .set({ hour: 10 })
          .toUTC()
          .toISO(),
      };
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .field('payload', JSON.stringify(input))
        .attach('inspiration', Buffer.from('<svg/>'), 'fake.jpg')
        .expect(400);
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#9955aa' },
      })
        .png()
        .toBuffer();
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .field('payload', JSON.stringify(input))
        .attach('inspiration', image, 'photo.png')
        .expect(201)
        .expect((r) => expect(r.body.status).toBe('pending_payment'));
      expect(await readdir(dir)).toHaveLength(1);
      expect(repo.media).toHaveLength(1);
      await agent
        .post('/api/bookings/hold')
        .set('x-csrf-token', csrf)
        .field(
          'payload',
          JSON.stringify({
            ...input,
            startAt: DateTime.fromISO(input.startAt)
              .plus({ minutes: 15 })
              .toISO(),
          }),
        )
        .attach('inspiration', image, 'photo.png')
        .expect(400);
      expect(await readdir(dir)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it.each(['+2348031234567', '+442079460018', '+14165551234', 'invalid'])(
  'rejects non-US or invalid phone %s',
  (phone) => {
    const result = holdSchema.safeParse({ ...validHold, phone });
    expect(result.success).toBe(false);
    expect(result.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['phone'],
        message: 'Invalid phone number',
      }),
    );
  },
);
it.each(['4437434979', '(443) 743-4979', '14437434979', '+14437434979'])(
  'normalizes a valid US phone %s',
  (phone) => {
    expect(holdSchema.parse({ ...validHold, phone }).phone).toBe(
      '+14437434979',
    );
  },
);

it('rejects live or mixed Stripe keys in local development', () => {
  const base = {
    NODE_ENV: 'development',
    SESSION_SECRET: 'test-secret-that-is-at-least-32-characters',
    DATABASE_URL: 'mysql://unused:unused@localhost/mado',
    UPLOAD_DIR: 'tmp/uploads',
  };
  expect(() =>
    parseEnv({
      ...base,
      STRIPE_SECRET_KEY: 'sk_live_test',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_test',
    }),
  ).toThrow();
  expect(() =>
    parseEnv({
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_test',
      STRIPE_PUBLISHABLE_KEY: 'pk_live_test',
    }),
  ).toThrow();
  expect(
    parseEnv({
      ...base,
      STRIPE_SECRET_KEY: 'sk_test_test',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_test',
    }).STRIPE_SECRET_KEY,
  ).toBe('sk_test_test');
});
