const optionNames = {
  medium: 'Medium',
  semi_medium: 'Semi-medium',
  small: 'Small',
  shoulder: 'Shoulder',
  mid_back: 'Mid back',
  waist: 'Waist',
  top_butt: 'Top butt',
  butt: 'Butt',
  under_butt: 'Under butt',
};
export const optionLabel = (parts) =>
  parts
    .filter(Boolean)
    .map((value) => optionNames[value] || value)
    .join(' · ') || 'Standard service';
const methods = {
  zelle: 'Zelle',
  cashapp: 'Cash App',
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
};
export const methodName = (method) => methods[method] || 'Other';
export function paymentSourceLabel(method, provider) {
  if (method === 'card')
    return provider === 'stripe' ? 'Stripe / card' : 'Card (in person)';
  return methods[method] || 'Not recorded';
}
// Same order as the appointment lists: proof under review, latest payment,
// then an opened card checkout.
export function bookingPaymentSource(booking, payments = [], proofs = []) {
  const latest = (rows) => [...rows].sort((a, b) => b.id - a.id)[0];
  const proof = latest(proofs.filter((p) => p.status === 'pending'));
  if (proof) return paymentSourceLabel(proof.method, 'manual');
  const payment = latest(payments.filter((p) => p.type !== 'refund'));
  if (payment) return paymentSourceLabel(payment.method, payment.provider);
  return booking.stripeCheckoutSessionId
    ? paymentSourceLabel('card', 'stripe')
    : paymentSourceLabel();
}
export function presentAppointment(row) {
  let snapshot = row.booking.priceSnapshot;
  if (typeof snapshot === 'string') {
    try {
      snapshot = JSON.parse(snapshot);
    } catch {
      snapshot = {};
    }
  }
  snapshot ||= {};
  return {
    ...row,
    styleName:
      snapshot.styleName || row.styleName || 'Style details unavailable',
    styleOption: optionLabel([snapshot.size, snapshot.length]),
    paymentSource: paymentSourceLabel(row.paymentMethod, row.paymentProvider),
    paymentReview: Boolean(Number(row.paymentReview)),
  };
}
