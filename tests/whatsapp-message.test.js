import { describe, it, expect } from 'vitest';
import { whatsappBookingMessage } from '../src/services/whatsappBookingMessage.js';
const detail = {
  booking: {
    id: 1,
    clientId: 1,
    ref: 'PJ-ABHWJ8',
    startAt: new Date('2026-10-05T16:00:00Z'),
    paidCents: 3000,
    balanceCents: 21000,
    priceSnapshot: {
      styleName: 'Knotless Braids',
      size: 'medium',
      length: 'mid_back',
    },
  },
  client: { name: 'Ade Bola', phoneE164: '+18722344096' },
};
describe('owner WhatsApp booking format', () => {
  it('matches the requested at-a-glance format using real amounts and Eastern daylight time', () => {
    expect(whatsappBookingMessage(detail, 1)).toBe(
      '💰 NEW BOOKING — Mado African Braids\n👤 Ade Bola · (872) 234-4096\n⭐ Returning client — 2nd visit\n💇🏾‍♀️ Medium Knotless Braids (Mid-back)\n📅 Monday, October 5, 2026 at 12:00 PM EDT\n💵 Paid $30.00 · Balance $210.00\n🔖 Code PJ-ABHWJ8',
    );
  });
  it('uses Eastern standard time in winter and distinguishes a first recorded visit', () => {
    const text = whatsappBookingMessage(
      {
        ...detail,
        booking: {
          ...detail.booking,
          startAt: new Date('2026-12-07T17:00:00Z'),
          paidCents: 24000,
          balanceCents: 0,
        },
      },
      0,
    );
    expect(text).toContain('First recorded visit');
    expect(text).toContain('12:00 PM EST');
    expect(text).toContain('Paid $240.00 · Balance $0.00');
  });
  it.each([
    [1, '2nd'],
    [2, '3rd'],
    [10, '11th'],
    [11, '12th'],
    [12, '13th'],
    [20, '21st'],
  ])('shows visit ordinal after %i completed visits', (count, label) => {
    expect(whatsappBookingMessage(detail, count)).toContain(label + ' visit');
  });
  it('clearly distinguishes unapproved payment proofs from confirmed bookings', () => {
    const text = whatsappBookingMessage(detail, 1, true);
    expect(text).toContain('🕓 PAYMENT REVIEW');
    expect(text).toContain('Payment proof awaiting owner approval');
    expect(text).not.toContain('NEW BOOKING');
  });
});
