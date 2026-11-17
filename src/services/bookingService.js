import { randomBytes, createHash, createHmac } from 'node:crypto';
import { DateTime } from 'luxon';
import { priceBooking } from './pricingService.js';
import { daySlots, remainingCapacity, ZONE } from './availabilityService.js';
import { BookingError } from './bookingErrors.js';

// All state transitions, including initial creation, are owned by this service.
export const transitions = {
  pending_payment: ['confirmed', 'expired', 'cancelled', 'payment_conflict'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: ['payment_conflict'],
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
export const tokenHash = (token) =>
  createHash('sha256').update(token).digest('hex');
export const accessToken = (ref, secret) =>
  createHmac('sha256', secret)
    .update('manage:' + ref)
    .digest('hex');
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
function paymentLifecycle(repository, clock) {
  async function locked(id, run) {
    const initial = await repository.bookingById(id);
    if (!initial)
      throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
    return repository.transaction(async (tx) => {
      const first = DateTime.fromJSDate(initial.startAt, {
        zone: ZONE,
      }).startOf('day');
      const last = DateTime.fromJSDate(initial.blockEndAt, { zone: ZONE })
        .minus({ milliseconds: 1 })
        .startOf('day');
      const dates = [];
      for (let day = first; day <= last; day = day.plus({ days: 1 }))
        dates.push(day.toISODate());
      await tx.lockDates(dates);
      const booking = await tx.bookingById(id);
      if (booking.startAt.getTime() !== initial.startAt.getTime())
        throw new BookingError('BOOKING_CHANGED', 'Please try again.', 409);
      booking.priceSnapshot = decode(booking.priceSnapshot);
      return run(tx, booking, clock());
    });
  }
  const save = (tx, booking, patch, now) =>
    tx.saveBooking(booking.id, { ...patch, updatedAt: now.toJSDate() });
  async function change(tx, booking, status, now) {
    if (booking.status !== status) assertTransition(booking.status, status);
    await save(tx, booking, { status }, now);
    booking.status = status;
  }
  async function queue(tx, booking, template, now) {
    await tx.queueJob({
      type: 'email',
      payload: { bookingId: booking.id, template },
      dedupeKey: `${template}:${booking.id}`,
      runAt: now.toJSDate(),
      status: 'pending',
    });
  }
  async function refundJob(tx, booking, intent, amount, now) {
    if (amount <= 0) return;
    await tx.queueJob({
      type: 'refundConflict',
      payload: {
        bookingId: booking.id,
        paymentIntentId: intent,
        amountCents: amount,
      },
      dedupeKey: `refund:${booking.id}:${intent}:${amount}`,
      runAt: now.toJSDate(),
      status: 'pending',
    });
  }
  async function reconcile(tx, booking, now) {
    const rows = await tx.payments(booking.id);
    const received = rows
      .filter((p) => p.type !== 'refund')
      .reduce((n, p) => n + p.amountCents, 0);
    const refunded = rows
      .filter((p) => p.type === 'refund')
      .reduce((n, p) => n + p.amountCents, 0);
    const paidCents = Math.max(0, received - refunded);
    const paymentStatus = refunded
      ? paidCents === 0
        ? 'refunded'
        : 'partially_refunded'
      : paidCents === 0
        ? 'unpaid'
        : paidCents >= booking.subtotalCents &&
            !booking.priceSnapshot.consultation
          ? 'paid_in_full'
          : 'deposit_paid';
    await save(
      tx,
      booking,
      {
        paidCents,
        balanceCents: Math.max(0, booking.subtotalCents - paidCents),
        paymentStatus,
      },
      now,
    );
  }
  return {
    async submitPaymentProof(id, input, reviewHours = 24) {
      if (
        !['zelle', 'cashapp'].includes(input.method) ||
        !Number.isInteger(reviewHours) ||
        reviewHours < 1 ||
        reviewHours > 48
      )
        throw new BookingError(
          'INVALID_INPUT',
          'Invalid manual payment details.',
        );
      return locked(id, async (tx, booking, now) => {
        const prior = await tx.proofs(id);
        if (prior.some((p) => p.status === 'pending'))
          throw new BookingError(
            'REVIEW_PENDING',
            'Your payment is already awaiting review.',
            409,
          );
        const initial =
          booking.status === 'pending_payment' &&
          booking.holdExpiresAt > now.toJSDate();
        const balance =
          ['confirmed', 'completed'].includes(booking.status) &&
          booking.paymentStatus === 'deposit_paid' &&
          booking.balanceCents > 0 &&
          !booking.priceSnapshot.consultation;
        if (!initial && !balance)
          throw new BookingError(
            'PAYMENT_UNAVAILABLE',
            'No payment is due for this booking.',
            409,
          );
        if (
          (await tx.attempts(id)).some((a) =>
            ['creating', 'open'].includes(a.status),
          )
        )
          throw new BookingError(
            'CHECKOUT_OPEN',
            'Return to your card checkout or call the studio before sending another payment.',
            409,
          );
        const amountCents = initial
          ? booking.priceSnapshot.dueTodayCents
          : booking.balanceCents;
        const paymentType = initial ? booking.paymentChoice : 'balance';
        const proofId = await tx.insertProof({
          bookingId: id,
          method: input.method,
          paymentType,
          amountCents,
          path: input.path,
          status: 'pending',
          createdAt: now.toJSDate(),
        });
        if (initial)
          await save(
            tx,
            booking,
            {
              holdExpiresAt: new Date(
                Math.min(
                  now.plus({ hours: reviewHours }).toMillis(),
                  booking.startAt.getTime(),
                ),
              ),
            },
            now,
          );
        await tx.notify({
          type: 'payment_review',
          title: 'Payment proof needs review',
          body: `${booking.ref}: ${input.method} payment submitted. Verify receipt before approval.`,
          url: '/admin/payment-reviews',
        });
        return { id: proofId, status: 'pending', amountCents };
      });
    },
    async reviewPaymentProof(proofId, decision, admin, note = '') {
      if (admin?.role !== 'owner')
        throw new BookingError('FORBIDDEN', 'Owner access required.', 403);
      const proof = await repository.proof(proofId);
      if (!proof)
        throw new BookingError('NOT_FOUND', 'Payment proof not found.', 404);
      return locked(proof.bookingId, async (tx, booking, now) => {
        const current = await tx.proof(proofId);
        if (current.status !== 'pending') return { status: current.status };
        if (decision === 'approve') {
          if (current.paymentType !== 'balance') {
            if (!['pending_payment', 'expired'].includes(booking.status))
              throw new BookingError(
                'BOOKING_CHANGED',
                'This booking needs manual reconciliation. Do not approve twice.',
                409,
              );
            const schedule = await tx.schedule(
              booking.startAt,
              booking.blockEndAt,
            );
            const catalog = await tx.catalog();
            const remaining = remainingCapacity(
              DateTime.fromJSDate(booking.startAt),
              DateTime.fromJSDate(booking.blockEndAt),
              schedule.bookings.filter((b) => b.id !== booking.id),
              catalog.settings.booking.capacity,
              now,
            );
            if (
              booking.startAt <= now.toJSDate() ||
              remaining < 1 ||
              schedule.timeBlocks.some(
                (b) =>
                  b.startAt < booking.blockEndAt && b.endAt > booking.startAt,
              )
            )
              throw new BookingError(
                'PAYMENT_CONFLICT',
                'This time is unavailable. Contact the client to arrange another time or a manual refund.',
                409,
              );
            await change(tx, booking, 'confirmed', now);
          } else if (
            !['confirmed', 'completed'].includes(booking.status) ||
            booking.paymentStatus !== 'deposit_paid' ||
            booking.balanceCents !== current.amountCents
          )
            throw new BookingError(
              'BOOKING_CHANGED',
              'The balance changed. Reconcile this payment before approval.',
              409,
            );
          await tx.insertPayment({
            bookingId: booking.id,
            type: current.paymentType,
            provider: 'manual',
            method: current.method,
            amountCents: current.amountCents,
            recordedByAdminId: admin.id,
            note: `Verified payment proof ${proofId}`,
          });
          await reconcile(tx, booking, now);
          await queue(
            tx,
            booking,
            current.paymentType === 'balance'
              ? 'balance-receipt'
              : 'booking-confirmation',
            now,
          );
        } else if (decision === 'reject') {
          if (
            current.paymentType !== 'balance' &&
            booking.status === 'pending_payment'
          )
            await change(tx, booking, 'cancelled', now);
        } else
          throw new BookingError('INVALID_INPUT', 'Choose approve or reject.');
        const status = decision === 'approve' ? 'approved' : 'rejected';
        await tx.saveProof(proofId, {
          status,
          reviewedBy: admin.id,
          reviewedAt: now.toJSDate(),
          reviewNote: note,
        });
        await tx.audit({
          adminId: admin.id,
          entity: 'payment_proof',
          entityId: proofId,
          action: decision,
          before: { status: 'pending' },
          after: { status, bookingId: booking.id },
        });
        return { status };
      });
    },
    async reserveCheckout(id, type) {
      return locked(id, async (tx, booking, now) => {
        if ((await tx.proofs(id)).some((p) => p.status === 'pending'))
          throw new BookingError(
            'REVIEW_PENDING',
            'Your payment is awaiting review. Please do not pay again.',
            409,
          );
        if (type === 'balance') {
          if (
            !['confirmed', 'completed'].includes(booking.status) ||
            booking.paymentStatus !== 'deposit_paid' ||
            booking.balanceCents <= 0 ||
            booking.priceSnapshot.consultation
          )
            throw new BookingError(
              'BALANCE_UNAVAILABLE',
              'No balance payment is available.',
              409,
            );
        } else if (
          booking.status !== 'pending_payment' ||
          booking.holdExpiresAt <= now.toJSDate()
        )
          throw new BookingError(
            'HOLD_EXPIRED',
            'This hold has expired. Choose another time.',
            409,
          );
        const attempts = await tx.attempts(id);
        let attempt = attempts.find(
          (a) =>
            a.paymentType === type &&
            ['creating', 'open'].includes(a.status) &&
            a.expiresAt > now.toJSDate(),
        );
        if (!attempt) {
          if (
            type !== 'balance' &&
            attempts.some((a) => a.paymentType !== 'balance')
          )
            throw new BookingError(
              'HOLD_EXPIRED',
              'Please choose your time again.',
              409,
            );
          const amountCents =
            type === 'balance'
              ? booking.balanceCents
              : booking.priceSnapshot.dueTodayCents;
          if (!Number.isSafeInteger(amountCents) || amountCents < 50)
            throw new BookingError(
              'INVALID_AMOUNT',
              'Please call the studio.',
              409,
            );
          // Stripe requires at least 30 minutes from receipt of the API request.
          // Use a ten-second transport allowance and match the local hold to it.
          const expiresAt = now
            .plus({ minutes: 30, seconds: 10 })
            .startOf('second')
            .toJSDate();
          attempt = {
            id:
              type === 'balance'
                ? `balance-${id}-${attempts.length + 1}`
                : `hold-${id}`,
            bookingId: id,
            paymentType: type,
            amountCents,
            status: 'creating',
            expiresAt,
            createdAt: now.toJSDate(),
          };
          await tx.insertAttempt(attempt);
          if (type !== 'balance')
            await save(tx, booking, { holdExpiresAt: expiresAt }, now);
        }
        return { booking, attempt, client: await tx.client(booking.clientId) };
      });
    },
    async attachCheckout(id, attemptId, session) {
      return locked(id, async (tx, booking, now) => {
        const attempt = await tx.attempt(attemptId);
        if (attempt.status === 'paid') return;
        if (
          attempt.paymentType !== 'balance' &&
          booking.status !== 'pending_payment'
        )
          throw new BookingError(
            'HOLD_EXPIRED',
            'Please choose another time.',
            409,
          );
        if (attempt.stripeSessionId && attempt.stripeSessionId !== session.id)
          throw new BookingError(
            'INVALID_SESSION',
            'Payment session mismatch.',
            409,
          );
        await tx.saveAttempt(attemptId, {
          stripeSessionId: session.id,
          status: session.payment_status === 'paid' ? 'paid' : 'open',
          expiresAt: new Date(session.expires_at * 1000),
        });
        // Only a verified webhook may mark a payment paid. An API retrieve does not.
        if (session.payment_status === 'paid')
          await tx.saveAttempt(attemptId, { status: 'open' });
        if (attempt.paymentType !== 'balance')
          await save(
            tx,
            booking,
            {
              stripeCheckoutSessionId: session.id,
              holdExpiresAt: new Date(session.expires_at * 1000),
            },
            now,
          );
      });
    },
    async releaseHold(id, status = 'cancelled', onlyExpired = false) {
      return locked(id, async (tx, booking, now) => {
        if (
          booking.status !== 'pending_payment' ||
          (onlyExpired && booking.holdExpiresAt > now.toJSDate())
        )
          return false;
        await change(tx, booking, status, now);
        return true;
      });
    },
    async applyStripeEvent(event) {
      const object = event.data.object;
      let attempt =
        object.object === 'checkout.session'
          ? (await repository.attemptBySession(object.id)) ||
            (await repository.attempt(object.metadata?.attemptId))
          : null;
      const payment =
        event.type === 'charge.refunded'
          ? await repository.paymentByIntent(
              typeof object.payment_intent === 'string'
                ? object.payment_intent
                : object.payment_intent?.id,
            )
          : null;
      const id = attempt?.bookingId || payment?.bookingId;
      if (!id) {
        if (
          object.metadata?.application === 'mado-braidz' &&
          object.metadata?.bookingId &&
          (await repository.bookingById(Number(object.metadata.bookingId)))
            ?.ref === object.metadata?.bookingRef
        )
          throw new BookingError(
            'EVENT_NOT_READY',
            'Payment is not ready to reconcile.',
            503,
          );
        // Persist unrelated event IDs too, but never trust metadata for amounts.
        return repository.transaction(async (tx) => {
          const existing = await tx.event(
            event.id,
            event.type,
            clock().toJSDate(),
          );
          if (!existing.processedAt)
            await tx.finishEvent(event.id, clock().toJSDate());
          return { ignored: true };
        });
      }
      return locked(id, async (tx, booking, now) => {
        const stored = await tx.event(event.id, event.type, now.toJSDate());
        if (stored.processedAt) return { duplicate: true, bookingId: id };
        if (event.type === 'charge.refunded') {
          const intent =
            typeof object.payment_intent === 'string'
              ? object.payment_intent
              : object.payment_intent?.id;
          const rows = await tx.payments(id);
          const received = rows
            .filter(
              (p) => p.stripePaymentIntentId === intent && p.type !== 'refund',
            )
            .reduce((n, p) => n + p.amountCents, 0);
          const old = rows
            .filter(
              (p) => p.stripePaymentIntentId === intent && p.type === 'refund',
            )
            .reduce((n, p) => n + p.amountCents, 0);
          if (
            object.currency !== 'usd' ||
            !Number.isSafeInteger(object.amount_refunded) ||
            object.amount_refunded > received
          )
            throw new BookingError(
              'INVALID_PAYMENT',
              'Refund amount mismatch.',
              400,
            );
          if (object.amount_refunded > old)
            await tx.insertPayment({
              bookingId: id,
              type: 'refund',
              provider: 'stripe',
              method: 'card',
              amountCents: object.amount_refunded - old,
              stripePaymentIntentId: intent,
              note: `Stripe cumulative refund ${object.amount_refunded}`,
            });
          await reconcile(tx, booking, now);
        } else {
          attempt = await tx.attempt(attempt.id);
          if (attempt.stripeSessionId && attempt.stripeSessionId !== object.id)
            throw new BookingError(
              'INVALID_SESSION',
              'Payment session mismatch.',
              400,
            );
          if (
            String(object.metadata?.bookingId) !== String(id) ||
            object.metadata?.application !== 'mado-braidz' ||
            object.metadata?.bookingRef !== booking.ref ||
            object.metadata?.paymentType !== attempt.paymentType ||
            object.metadata?.attemptId !== attempt.id
          )
            throw new BookingError(
              'INVALID_PAYMENT',
              'Payment metadata mismatch.',
              400,
            );
          if (
            [
              'checkout.session.expired',
              'checkout.session.async_payment_failed',
            ].includes(event.type)
          ) {
            if (attempt.status !== 'paid') {
              await tx.saveAttempt(attempt.id, {
                status: 'expired',
                stripeSessionId: object.id,
              });
              if (
                attempt.paymentType !== 'balance' &&
                booking.status === 'pending_payment'
              )
                await change(tx, booking, 'expired', now);
            }
          } else if (
            [
              'checkout.session.completed',
              'checkout.session.async_payment_succeeded',
            ].includes(event.type) &&
            object.payment_status === 'paid'
          ) {
            const intent =
              typeof object.payment_intent === 'string'
                ? object.payment_intent
                : object.payment_intent?.id;
            if (
              object.currency !== 'usd' ||
              object.amount_total !== attempt.amountCents ||
              !intent
            )
              throw new BookingError(
                'INVALID_PAYMENT',
                'Payment amount mismatch.',
                400,
              );
            if (
              attempt.status !== 'paid' &&
              !(await tx.paymentByIntent(intent))
            ) {
              await tx.saveAttempt(attempt.id, {
                status: 'paid',
                stripeSessionId: object.id,
                stripePaymentIntentId: intent,
              });
              if (attempt.paymentType !== 'balance')
                await save(
                  tx,
                  booking,
                  { stripeCheckoutSessionId: object.id },
                  now,
                );
              await tx.insertPayment({
                bookingId: id,
                type: attempt.paymentType,
                provider: 'stripe',
                method: event.paymentMethod || 'card',
                amountCents: attempt.amountCents,
                stripePaymentIntentId: intent,
              });
              let conflict = false,
                refund = 0;
              if (attempt.paymentType === 'balance') {
                refund = ['confirmed', 'completed'].includes(booking.status)
                  ? Math.max(0, attempt.amountCents - booking.balanceCents)
                  : attempt.amountCents;
              } else if (
                ['pending_payment', 'expired'].includes(booking.status)
              ) {
                const schedule = await tx.schedule(
                  booking.startAt,
                  booking.blockEndAt,
                );
                const catalog = await tx.catalog();
                const start = DateTime.fromJSDate(booking.startAt, {
                    zone: 'utc',
                  }),
                  end = DateTime.fromJSDate(booking.blockEndAt, {
                    zone: 'utc',
                  });
                const remaining = remainingCapacity(
                  start,
                  end,
                  schedule.bookings.filter((b) => b.id !== id),
                  catalog.settings.booking.capacity,
                  now,
                );
                const blocked = schedule.timeBlocks.some(
                  (b) =>
                    b.startAt < booking.blockEndAt && b.endAt > booking.startAt,
                );
                conflict = remaining < 1 || blocked;
                await change(
                  tx,
                  booking,
                  conflict ? 'payment_conflict' : 'confirmed',
                  now,
                );
                if (!conflict) {
                  await queue(tx, booking, 'booking-confirmation', now);
                  await tx.notify({
                    type: 'booking_confirmed',
                    title: 'A chair is booked',
                    body: booking.ref,
                    url: `/admin/bookings/${id}`,
                  });
                }
              } else {
                conflict = true;
                if (booking.status === 'cancelled')
                  await change(tx, booking, 'payment_conflict', now);
              }
              if (conflict) {
                refund = attempt.amountCents;
                await queue(tx, booking, 'payment-conflict', now);
                await tx.notify({
                  type: 'payment_conflict',
                  title: 'Payment needs a refund',
                  body: booking.ref,
                  url: `/admin/bookings/${id}`,
                });
              }
              await reconcile(tx, booking, now);
              await refundJob(tx, booking, intent, refund, now);
            }
          }
        }
        await tx.finishEvent(event.id, now.toJSDate());
        return { bookingId: id };
      });
    },
    async finishRefund(job, refund) {
      const payload = decode(job.payload);
      return locked(payload.bookingId, async (tx, booking, now) => {
        const rows = await tx.payments(booking.id);
        const old = rows
          .filter(
            (p) =>
              p.stripePaymentIntentId === payload.paymentIntentId &&
              p.type === 'refund',
          )
          .reduce((n, p) => n + p.amountCents, 0);
        // charge.refunded may have arrived before this API response; reconcile once.
        const cumulative = refund.cumulativeAmountRefunded;
        if (
          refund.status === 'succeeded' &&
          (!Number.isSafeInteger(cumulative) ||
            cumulative < payload.amountCents)
        )
          throw new BookingError(
            'INVALID_REFUND',
            'Refund needs reconciliation.',
            503,
          );
        if (refund.status === 'succeeded' && old < cumulative)
          await tx.insertPayment({
            bookingId: booking.id,
            type: 'refund',
            provider: 'stripe',
            method: 'card',
            amountCents: cumulative - old,
            stripePaymentIntentId: payload.paymentIntentId,
            stripeRefundId: refund.id,
          });
        await reconcile(tx, booking, now);
        await tx.saveJob(job.id, {
          status: refund.status === 'succeeded' ? 'done' : 'pending',
          payload: { ...payload, refundId: refund.id },
          attempts: job.attempts + 1,
          lastError: null,
        });
      });
    },
  };
}
export function createBookingService(
  repository,
  clock = () => DateTime.utc(),
  tokenSecret = null,
) {
  const service = {
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
        if (input.checkoutRequestKey && tx.bookingByRequest) {
          const existing = await tx.bookingByRequest(input.checkoutRequestKey);
          if (existing) {
            const snapshot = decode(existing.priceSnapshot);
            if (
              existing.startAt.getTime() !== start.toMillis() ||
              existing.styleId !== input.styleId ||
              existing.styleVariantId !== (input.styleVariantId || null) ||
              existing.paymentChoice !== input.paymentChoice ||
              JSON.stringify(snapshot.addons.map((a) => a.id).sort()) !==
                JSON.stringify([...input.addonIds].sort())
            )
              throw new BookingError(
                'REQUEST_CHANGED',
                'Please start a new booking.',
                409,
              );
            return {
              id: existing.id,
              ref: existing.ref,
              status: existing.status,
              holdExpiresAt: existing.holdExpiresAt.toISOString(),
              price: snapshot,
              reused: true,
              manageToken: accessToken(existing.ref, tokenSecret),
            };
          }
        }
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
        const manageToken = tokenSecret
          ? accessToken(ref, tokenSecret)
          : randomBytes(32).toString('hex');
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
            manageTokenHash: tokenHash(manageToken),
            checkoutRequestKey: input.checkoutRequestKey || null,
            policyAcceptedAt: now.toJSDate(),
            updatedAt: now.toJSDate(),
          },
          price.addons,
        );
        return {
          id,
          ref,
          status: 'pending_payment',
          manageToken,
          holdExpiresAt: expires.toUTC().toISO(),
          price,
          message:
            'Your time is temporarily held. No payment has been taken and your appointment is not confirmed. Online payment is coming next; call the studio to arrange your visit.',
        };
      });
    },
  };
  return Object.assign(service, paymentLifecycle(repository, clock));
}
