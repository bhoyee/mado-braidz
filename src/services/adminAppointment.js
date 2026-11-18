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
  const labels = {
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
  const method = row.paymentMethod;
  return {
    ...row,
    styleName:
      snapshot.styleName || row.styleName || 'Style details unavailable',
    styleOption:
      [snapshot.size, snapshot.length]
        .filter(Boolean)
        .map((value) => labels[value] || value)
        .join(' · ') || 'Standard service',
    paymentSource:
      method === 'card'
        ? row.paymentProvider === 'stripe'
          ? 'Stripe / card'
          : 'Card (in person)'
        : { zelle: 'Zelle', cashapp: 'Cash App', cash: 'Cash', other: 'Other' }[
            method
          ] || 'Not recorded',
    paymentReview: Boolean(Number(row.paymentReview)),
  };
}
