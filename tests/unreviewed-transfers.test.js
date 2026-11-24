import { describe, expect, it } from 'vitest';
import { createBookingService } from '../src/services/bookingService.js';
import { createNotificationService } from '../src/services/notificationService.js';
import { renderEmail } from '../src/services/emailService.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import { paymentConfig } from './fixtures/stripe.js';
import {
  awaitingReview,
  proofOf,
  sampleDetail,
} from './fixtures/bookingEmail.js';

const owner = { id: 1, role: 'owner' };
async function setup(hold = validHold) {
  const repo = await memoryBookingRepository();
  let time = now;
  const service = createBookingService(
    repo,
    () => time,
    paymentConfig.SESSION_SECRET,
  );
  const booking = await service.createHold(hold);
  const submit = () =>
    service.submitPaymentProof(booking.id, {
      method: 'cashapp',
      path: 'private.webp',
    });
  return {
    repo,
    service,
    booking,
    submit,
    row: () => repo.rows[0],
    at: (duration) => (time = now.plus(duration)),
    run: () => expireHolds(repo, service, time),
    alerts: (type) => repo.notificationRows.filter((n) => n.type === type),
    emails: (template) =>
      repo.jobRows.filter(
        (j) => j.type === 'email' && j.payload.template === template,
      ),
  };
}

describe('transfers the owner has not reviewed', () => {
  it('holds the chair one extra day with an urgent alert, then releases it and emails both', async () => {
    const f = await setup();
    await f.submit();
    const first = +f.row().holdExpiresAt;
    f.at({ hours: 23, minutes: 55 });
    expect(await f.run()).toBe(0);
    expect(+f.row().holdExpiresAt).toBe(first + 24 * 3600000);
    expect(f.row().status).toBe('pending_payment');
    expect(f.alerts('payment_review_urgent')).toHaveLength(1);
    expect(f.emails('payment-review-expired')).toHaveLength(0);

    // Running again never extends twice.
    f.at({ hours: 47, minutes: 55 });
    expect(await f.run()).toBe(0);
    expect(+f.row().holdExpiresAt).toBe(first + 24 * 3600000);

    f.at({ hours: 48, minutes: 5 });
    expect(await f.run()).toBe(1);
    expect(f.row()).toMatchObject({ status: 'expired', paidCents: 0 });
    expect(f.alerts('payment_review_expired')).toHaveLength(1);
    expect(f.emails('payment-review-expired')).toHaveLength(1);
    expect(f.repo.paymentRows).toHaveLength(0);
    expect(await f.run()).toBe(0);
    expect(f.emails('payment-review-expired')).toHaveLength(1);
  });
  it('lets the owner approve after the extension and after release while the chair is free', async () => {
    for (const hours of [30, 49]) {
      const f = await setup();
      const proof = await f.submit();
      f.at({ hours: 24, minutes: 1 });
      await f.run();
      f.at({ hours });
      await f.run();
      await f.service.reviewPaymentProof(proof.id, 'approve', owner);
      expect(f.row()).toMatchObject({ status: 'confirmed', paidCents: 3000 });
      expect(f.emails('booking-confirmation')).toHaveLength(1);
    }
  });
  it('never extends past the appointment', async () => {
    const f = await setup();
    await f.submit();
    f.row().startAt = now.plus({ hours: 30 }).toJSDate();
    f.row().endAt = f.row().blockEndAt = now.plus({ hours: 34 }).toJSDate();
    f.at({ hours: 24, minutes: 1 });
    await f.run();
    expect(+f.row().holdExpiresAt).toBe(+now.plus({ hours: 30 }));
    f.at({ hours: 30, minutes: 1 });
    expect(await f.run()).toBe(1);
  });
  it('does not extend into a blocked time', async () => {
    const f = await setup();
    await f.submit();
    f.repo.timeBlocks.push({
      startAt: f.row().startAt,
      endAt: f.row().blockEndAt,
    });
    f.at({ hours: 24, minutes: 1 });
    expect(await f.run()).toBe(1);
    expect(f.row().status).toBe('expired');
  });
  it('does nothing once reviewed, and never extends a card hold', async () => {
    const reviewed = await setup();
    const proof = await reviewed.submit();
    await reviewed.service.reviewPaymentProof(proof.id, 'approve', owner);
    reviewed.at({ hours: 60 });
    expect(await reviewed.run()).toBe(0);
    expect(reviewed.row().status).toBe('confirmed');
    expect(reviewed.alerts('payment_review_urgent')).toHaveLength(0);

    const card = await setup();
    card.at({ minutes: 25 });
    expect(await card.run()).toBe(0);
    card.at({ minutes: 31 });
    expect(await card.run()).toBe(1);
    expect(card.emails('payment-review-expired')).toHaveLength(0);
  });
});

describe('review reminders', () => {
  const hold = now.plus({ hours: 24 });
  async function remind(time, submitted = now) {
    const keys = [];
    const service = createNotificationService(
      {
        context: async () => ({
          bookings: [],
          clients: [],
          settings: {},
          notifications: [],
        }),
        pendingReviews: async () => [
          {
            proofId: 4,
            bookingId: 7,
            ref: 'MADO-X',
            submittedAt: submitted.toJSDate(),
            holdExpiresAt: hold.toJSDate(),
          },
        ],
        notifyOnce: async (key, value) => keys.push([key, value.title]),
        queue: async () => {},
        pending: async () => [],
        lifecycleJobs: async () => [],
        failedJobs: async () => [],
      },
      paymentConfig,
      { clock: () => time.toJSDate(), email: {}, whatsapp: {} },
    );
    await service.schedule();
    return keys.map(([, title]) => title);
  }
  it('reminds at 6 hours and 1 hour, not earlier or after the deadline', async () => {
    expect(await remind(hold.minus({ hours: 7 }))).toEqual([]);
    expect(await remind(hold.minus({ hours: 5, minutes: 58 }))).toEqual([
      'Payment needs review within 6 hours',
    ]);
    expect(await remind(hold.minus({ minutes: 55 }))).toEqual([
      'Payment needs review within 1 hour',
    ]);
    expect(await remind(hold.plus({ minutes: 1 }))).toEqual([]);
  });
  it('does not remind straight after a late submission', async () => {
    expect(
      await remind(
        hold.minus({ hours: 4 }),
        hold.minus({ hours: 4, minutes: 1 }),
      ),
    ).toEqual([]);
  });
});

describe('unreviewed transfer emails', () => {
  const config = {
    APP_URL: 'https://salon.example',
    SESSION_SECRET: 'x'.repeat(32),
  };
  const alert = (kind, booking = {}, extras = {}) =>
    renderEmail(
      config,
      { template: 'admin-alert', url: '/admin/bookings/7', body: 'Update' },
      null,
      {},
      {
        proof: proofOf('cashapp'),
        ...extras,
        alert: {
          kind,
          detail: sampleDetail({ ...awaitingReview, ...booking }),
        },
      },
    );
  it('tells the owner what happens next, accurately', async () => {
    const first = await alert('payment_review_reminder');
    expect(first.subject).toBe(
      'Reminder: review Cash App payment: Ade Bola, $30.00',
    );
    expect(first.html).toContain('extended once by up to 24 hours');
    const last = await alert('payment_review_urgent', {}, { extended: true });
    expect(last.subject).toMatch(/^Urgent: /);
    expect(last.html).toContain('The chair is released if you');
    expect(last.html).not.toContain('extended once');
    const ended = await alert('payment_review_expired', { status: 'expired' });
    expect(ended.subject).toBe(
      'Hold ended: check Cash App for Ade Bola, $30.00',
    );
    expect(ended.html).toContain(
      'You can still approve it if the time is free',
    );
    expect(ended.html).toContain('Call Ade');
  });
  it('apologises to the client and asks them not to pay again', async () => {
    const mail = await renderEmail(
      config,
      {
        template: 'payment-review-expired',
        method: 'zelle',
        amountCents: 3000,
      },
      sampleDetail({ status: 'expired', paidCents: 0 }),
    );
    for (const text of [
      'We are sorry',
      'Zelle payment sent, not yet verified',
      '$30.00',
      'do not pay again',
      'Call the studio',
    ])
      expect(mail.html).toContain(text);
    expect(mail.html).not.toContain('is confirmed');
  });
});
