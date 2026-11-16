import { randomBytes, createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { priceBooking } from './pricingService.js';
import { daySlots, ZONE } from './availabilityService.js';
import { BookingError } from './bookingErrors.js';

// All state transitions, including initial creation, are owned by this service.
export const transitions = {
  pending_payment: ['confirmed', 'expired', 'cancelled', 'payment_conflict'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
  expired: ['confirmed', 'payment_conflict'],
  payment_conflict: [],
};
export function assertTransition(from, to) {
  if (!transitions[from]?.includes(to))
    throw new BookingError(
      'INVALID_TRANSITION',
      'This booking cannot change to that state.',
      409,
    );
}
export function createBookingService(repository, clock = () => DateTime.utc()) {
  return {
    async createHold(input, inspiration = null) {
      const start = DateTime.fromISO(input.startAt, { setZone: true }).setZone(
        ZONE,
      );
      if (!start.isValid)
        throw new BookingError(
          'INVALID_START',
          'Choose an available start time.',
        );
      return repository.transaction(async (tx) => {
        // Lock before any consistent reads so a waiter gets a fresh RR snapshot.
        // Public slots must fit one opening day, including the buffer.
        await tx.lockDates([start.toISODate()]);
        const now = clock();
        const catalog = await tx.catalog();
        const price = priceBooking(catalog, input);
        const schedule = await tx.schedule(
          start.startOf('day').toJSDate(),
          start.plus({ days: 1 }).startOf('day').toJSDate(),
        );
        const slots = daySlots({
          date: start.toISODate(),
          durationMin: price.durationMin,
          settings: catalog.settings,
          ...schedule,
          now,
        });
        const slot = slots.find(
          (s) => DateTime.fromISO(s.startAt).toMillis() === start.toMillis(),
        );
        if (!slot)
          throw new BookingError(
            'INVALID_START',
            'Choose a start within opening hours and booking notice.',
          );
        if (!slot.available)
          throw new BookingError(
            'SLOT_TAKEN',
            'That time is now fully booked. Choose another start.',
            409,
            {
              alternatives: slots
                .filter(
                  (s) => s.available && DateTime.fromISO(s.startAt) >= start,
                )
                .slice(0, 3),
            },
          );
        const clientId = await tx.insertClient({
          name: input.name,
          email: input.email,
          phoneE164: input.phone,
          marketingConsent: input.marketingConsent,
          consentAt: input.marketingConsent ? now.toJSDate() : null,
        });
        const inspirationMediaId = inspiration
          ? await tx.insertMedia(inspiration)
          : null;
        const ref = 'MADO-' + randomBytes(8).toString('hex').toUpperCase();
        const expires = now.plus({
          minutes: catalog.settings.booking.holdMinutes,
        });
        const id = await tx.insertBooking(
          {
            ref,
            clientId,
            styleId: price.styleId,
            styleVariantId: price.styleVariantId,
            startAt: DateTime.fromISO(slot.startAt).toJSDate(),
            endAt: DateTime.fromISO(slot.endAt).toJSDate(),
            blockEndAt: DateTime.fromISO(slot.blockEndAt).toJSDate(),
            status: 'pending_payment',
            paymentStatus: 'unpaid',
            paymentChoice: input.paymentChoice,
            source: 'web',
            holdExpiresAt: expires.toJSDate(),
            priceSnapshot: price,
            subtotalCents: price.subtotalCents,
            depositCents: price.depositCents,
            paidCents: 0,
            balanceCents: price.subtotalCents,
            clientNotes: input.notes || null,
            inspirationMediaId,
            manageTokenHash: createHash('sha256')
              .update(randomBytes(32))
              .digest('hex'),
            policyAcceptedAt: now.toJSDate(),
            updatedAt: now.toJSDate(),
          },
          price.addons,
        );
        return {
          id,
          ref,
          status: 'pending_payment',
          holdExpiresAt: expires.toUTC().toISO(),
          price,
          message:
            'Your time is temporarily held. No payment has been taken and your appointment is not confirmed. Online payment is coming next; call the studio to arrange your visit.',
        };
      });
    },
  };
}
