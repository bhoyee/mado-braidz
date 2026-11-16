import { BookingError } from './bookingErrors.js';

export function priceBooking(catalog, selection) {
  const style = catalog.styles.find(
    (s) => s.id === selection.styleId && s.active !== false,
  );
  if (!style)
    throw new BookingError('INVALID_STYLE', 'Choose an available style.');
  const variant = style.variants.find(
    (v) => v.id === selection.styleVariantId && v.active !== false,
  );
  if (!style.priceOnConsultation && !variant)
    throw new BookingError(
      'INVALID_VARIANT',
      'Choose a valid size and length for this style.',
    );
  if (style.priceOnConsultation && selection.styleVariantId)
    throw new BookingError(
      'INVALID_VARIANT',
      'This style needs a consultation.',
    );
  const ids = selection.addonIds || [];
  if (new Set(ids).size !== ids.length)
    throw new BookingError('INVALID_ADDONS', 'Choose each extra only once.');
  const addons = ids.map((id) => {
    const addon = catalog.addons.find((a) => a.id === id && a.active !== false);
    if (!addon || (!addon.appliesToAll && !addon.styleIds?.includes(style.id)))
      throw new BookingError(
        'INVALID_ADDONS',
        'An extra is unavailable for this style.',
      );
    return {
      id: addon.id,
      name: addon.name,
      priceCents: addon.priceCents,
      durationMin: addon.durationMin,
    };
  });
  const config = catalog.settings.booking;
  const consultation = Boolean(style.priceOnConsultation);
  if (consultation && selection.paymentChoice === 'full')
    throw new BookingError(
      'CONSULTATION_DEPOSIT_ONLY',
      'Choose the deposit; your final price is agreed at consultation.',
    );
  const stylePriceCents = consultation ? null : variant.priceCents;
  // A consultation has an unknown final service price, not a free service.
  // Its provisional subtotal covers the deposit plus any selected extras.
  const subtotalCents =
    (stylePriceCents ?? config.depositCents) +
    addons.reduce((n, a) => n + a.priceCents, 0);
  const depositCents = Math.min(config.depositCents, subtotalCents);
  const dueTodayCents =
    selection.paymentChoice === 'full' ? subtotalCents : depositCents;
  const durationMin =
    (variant?.durationMin ?? style.durationMin ?? config.defaultDurationMin) +
    addons.reduce((n, a) => n + a.durationMin, 0);
  if (
    ![
      stylePriceCents ?? config.depositCents,
      config.depositCents,
      subtotalCents,
      depositCents,
      dueTodayCents,
      durationMin,
      ...addons.flatMap((a) => [a.priceCents, a.durationMin]),
    ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    durationMin === 0
  )
    throw new BookingError(
      'INVALID_CATALOG',
      'The price menu needs an update. Please call the studio.',
      503,
    );
  return {
    styleId: style.id,
    styleVariantId: variant?.id ?? null,
    styleName: style.name,
    size: variant?.size ?? null,
    length: variant?.length ?? null,
    consultation,
    stylePriceCents,
    addons,
    subtotalCents,
    depositCents,
    dueTodayCents,
    balanceAfterPaymentCents: consultation
      ? null
      : subtotalCents - dueTodayCents,
    durationMin,
    hairIncluded: true,
    includedHumanHairPercent: 50,
  };
}
