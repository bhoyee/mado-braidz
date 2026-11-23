import { describe, expect, it } from 'vitest';
import { renderEmail } from '../src/services/emailService.js';
import { createNotificationService } from '../src/services/notificationService.js';
import {
  awaitingReview,
  cardDeposit,
  proofOf,
  sampleDetail,
} from './fixtures/bookingEmail.js';

const config = {
  APP_URL: 'https://salon.example',
  SESSION_SECRET: 'x'.repeat(32),
};
const owner = (kind, detail, extras = {}, url = '/admin/bookings/7') =>
  renderEmail(
    config,
    { template: 'admin-alert', body: 'A chair is booked', url },
    null,
    {},
    { ...extras, alert: { kind, detail } },
  );
const customer = (template, detail, settings = {}, extras = {}) =>
  renderEmail(config, { template }, detail, settings, extras);

describe('owner booking alerts', () => {
  it('shows the whole booking at a glance', async () => {
    const mail = await owner('booking_confirmed', sampleDetail(), {
      payments: cardDeposit,
      visits: 1,
    });
    expect(mail.subject).toBe('New booking: Ade Bola, Sat Dec 5 at 10:00 AM');
    for (const text of [
      'Saturday, December 5, 2026',
      '10:00 AM to 2:00 PM Eastern',
      '(443) 743-4979',
      'tel:+14437434979',
      'ade@example.com',
      'Returning client, 2nd visit',
      'Medium, mid-back',
      'Extras: 100% human hair upgrade',
      '$220.00',
      'Paid: deposit by card',
      '$30.00',
      'Balance to collect',
      '$190.00',
      'sensitive scalp',
      'https://salon.example/admin/bookings/7',
    ])
      expect(mail.html).toContain(text);
    expect(mail.text).toContain('Balance to collect: $190.00');
    expect(mail.attachments).toEqual([]);
  });
  it.each([
    ['zelle', 'Zelle'],
    ['cashapp', 'Cash App'],
  ])(
    'keeps a %s payment clearly unconfirmed until review',
    async (key, name) => {
      const mail = await owner(
        'payment_review',
        sampleDetail(awaitingReview),
        { proof: proofOf(key) },
        '/admin/payment-reviews',
      );
      expect(mail.subject).toBe(`Review ${name} payment: Ade Bola, $30.00`);
      for (const text of [
        'Not confirmed yet',
        `Check your ${name} for $30.00`,
        'Review by Tue, Nov 24 at 7:20 PM Eastern',
        'Deposit to verify',
        '$190.00',
        'https://salon.example/admin/payment-reviews',
      ])
        expect(mail.html).toContain(text);
      expect(mail.html).not.toContain('>Confirmed<');
    },
  );
  it('does not threaten to release the chair for a balance payment', async () => {
    const mail = await owner('payment_review', sampleDetail(), {
      proof: proofOf('zelle', { paymentType: 'balance', amountCents: 19000 }),
    });
    expect(mail.html).toContain('Balance to verify');
    expect(mail.html).not.toContain('released');
  });
  it('handles full payment, consultation prices and missing details', async () => {
    const full = await owner(
      'booking_confirmed',
      sampleDetail({ paidCents: 22000, balanceCents: 0 }),
      { payments: [{ type: 'full', method: 'card', amountCents: 22000 }] },
    );
    expect(full.html).toContain('Nothing to collect');
    expect(full.html).toContain('Paid in full by card');
    const detail = sampleDetail(
      { clientNotes: '', inspirationMediaId: null },
      { phoneE164: '' },
    );
    detail.booking.priceSnapshot.consultation = true;
    detail.booking.priceSnapshot.addons = [];
    const plain = await owner('booking_confirmed', detail);
    expect(plain.html).toContain('Agreed at consultation');
    expect(plain.html).not.toContain('Extras');
    expect(plain.html).not.toContain('note</h2>');
    expect(plain.html).not.toContain('>Call Ade');
  });
  it('falls back to the short alert when the booking has moved on', async () => {
    const moved = await owner(
      'booking_confirmed',
      sampleDetail({ status: 'cancelled' }),
    );
    expect(moved.subject).toBe('A studio update needs your attention');
    expect(moved.html).not.toContain('Ade Bola');
    const reviewed = await owner('payment_review', sampleDetail());
    expect(reviewed.subject).toBe('A studio update needs your attention');
  });
  it('escapes client text and keeps subjects on one line', async () => {
    const mail = await owner(
      'booking_confirmed',
      sampleDetail(
        { clientNotes: '<img src=x onerror=alert(1)>' },
        { name: 'A\r\nBcc: x@example.test <b>' },
      ),
    );
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain('<img src=x');
    expect(mail.html).not.toContain('<b>');
  });
});

describe('customer booking emails', () => {
  it('confirms every detail and follows the studio policy', async () => {
    const mail = await customer(
      'booking-confirmation',
      sampleDetail(),
      { policy: { rescheduleHours: 24, freeReschedules: 2 } },
      { payments: cardDeposit },
    );
    expect(mail.subject).toBe('Your chair is booked: Sat Dec 5 at 10:00 AM');
    for (const text of [
      'Ade, your chair is booked',
      '10:00 AM to 2:00 PM Eastern',
      'Deposit paid by card',
      'Balance remaining',
      'Get directions',
      'washed and detangled',
      '2 free reschedules with at least 24 hours',
      'non-refundable',
      'MADO-4F8A21C09B7E35D6',
    ])
      expect(mail.html).toContain(text);
    expect(mail.html).not.toContain('sensitive scalp');
    expect(mail.attachments).toHaveLength(1);
  });
  it('skips wash advice when a head wash is booked', async () => {
    const detail = sampleDetail();
    detail.booking.priceSnapshot.addons = [{ id: 1, name: 'Head wash' }];
    const mail = await customer('booking-confirmation', detail);
    expect(mail.html).not.toContain('detangled');
  });
  it('keeps the owner’s custom subject and intro', async () => {
    const mail = await customer('booking-confirmation', sampleDetail(), {
      emailTemplates: {
        'booking-confirmation': {
          subject: 'You’re in',
          intro: 'Custom welcome.',
        },
      },
    });
    expect(mail.subject).toBe('You’re in');
    expect(mail.html).toContain('Custom welcome.');
  });
  it('does not ask for a balance after cancellation', async () => {
    const mail = await customer(
      'booking-cancelled',
      sampleDetail({ status: 'cancelled' }),
    );
    expect(mail.subject).toContain('cancelled: Sat Dec 5');
    expect(mail.html).not.toContain('Balance remaining');
    expect(mail.html).not.toContain('Before you come');
  });
});

it('sends the detailed alert from a queued notification', async () => {
  const now = new Date('2026-11-24T01:00:00Z');
  const detail = sampleDetail();
  const sent = [];
  const job = {
    id: 1,
    type: 'email',
    attempts: 0,
    payload: {
      template: 'admin-alert',
      notificationId: 5,
      body: 'A chair is booked',
      url: '/admin/bookings/7',
    },
  };
  const repository = {
    context: async () => ({
      bookings: [detail.booking],
      clients: [detail.client],
      settings: { emails: { adminAlertEmails: ['one@example.test'] } },
      notifications: [],
    }),
    detail: async () => detail,
    emailContext: async () => ({ payments: cardDeposit }),
    completedVisitsBefore: async () => 0,
    notification: async () => ({
      id: 5,
      type: 'booking_confirmed',
      url: '/admin/bookings/7',
      body: detail.booking.ref,
    }),
    queue: async () => {},
    notify: async () => {},
    notifyOnce: async () => {},
    pending: async () => [],
    lifecycleJobs: async () => [],
    failedJobs: async () => [],
    due: async () => [job],
    saveJob: async () => {},
    suppressed: async () => false,
    log: async () => ({ id: 1, status: 'pending' }),
    reserveLog: async () => ({ id: 1 }),
    saveLog: async () => {},
    cleanup: async () => {},
  };
  const service = createNotificationService(
    repository,
    { ...config, EMAIL_ENABLED: true, EMAIL_PROVIDER: 'brevo' },
    {
      clock: () => now,
      email: { send: async (to, mail) => sent.push([to, mail.subject]) },
      whatsapp: {},
    },
  );
  expect(await service.run()).toEqual({ sent: 1, failed: 0 });
  expect(sent).toEqual([
    ['one@example.test', 'New booking: Ade Bola, Sat Dec 5 at 10:00 AM'],
  ]);
});
