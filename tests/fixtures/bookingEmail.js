// Sample data only, shared by tests and the local email preview.
export function sampleDetail(booking = {}, client = {}) {
  return {
    booking: {
      id: 7,
      clientId: 3,
      ref: 'MADO-4F8A21C09B7E35D6',
      styleId: 1,
      status: 'confirmed',
      paymentStatus: 'deposit_paid',
      source: 'web',
      createdAt: new Date('2026-11-24T00:20:00Z'),
      startAt: new Date('2026-12-05T15:00:00Z'),
      endAt: new Date('2026-12-05T19:00:00Z'),
      subtotalCents: 22000,
      paidCents: 3000,
      balanceCents: 19000,
      clientNotes: 'I have a sensitive scalp. Please keep the front loose.',
      inspirationMediaId: 9,
      priceSnapshot: {
        styleName: 'Knotless Braids',
        size: 'medium',
        length: 'mid_back',
        addons: [{ id: 2, name: '100% human hair upgrade' }],
        consultation: false,
        subtotalCents: 22000,
      },
      ...booking,
    },
    client: {
      id: 3,
      name: 'Ade Bola',
      email: 'ade@example.com',
      phoneE164: '+14437434979',
      ...client,
    },
  };
}
export const cardDeposit = [
  { type: 'deposit', method: 'card', amountCents: 3000 },
];
export const proofOf = (method, values = {}) => ({
  method,
  paymentType: 'deposit',
  amountCents: 3000,
  status: 'pending',
  ...values,
});
export const awaitingReview = {
  status: 'pending_payment',
  paymentStatus: 'unpaid',
  paidCents: 0,
  balanceCents: 22000,
  holdExpiresAt: new Date('2026-11-25T00:20:00Z'),
};
