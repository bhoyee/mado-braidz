import { DateTime } from 'luxon';
import { daySlots, remainingCapacity, ZONE } from './availabilityService.js';
import { priceBooking } from './pricingService.js';
import { BookingError } from './bookingErrors.js';

const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
const fail = (message, code = 'BOOKING_UNAVAILABLE') => {
  throw new BookingError(code, message, 409);
};
export function adminBookingLifecycle(
  repository,
  clock,
  { change, reconcile, save },
) {
  async function locked(id, actor, input, run) {
    if (actor?.role !== 'owner')
      throw new BookingError('FORBIDDEN', 'Owner access required.', 403);
    const before = await repository.bookingById(id);
    if (!before) throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
    return repository.transaction(async (tx) => {
      const dates = [
        DateTime.fromJSDate(before.startAt, { zone: ZONE }).toISODate(),
      ];
      if (input.startAt)
        dates.push(
          DateTime.fromISO(input.startAt, { setZone: true })
            .setZone(ZONE)
            .toISODate(),
        );
      await tx.lockDates(dates);
      const row = await tx.bookingById(id);
      if (
        +row.startAt !== +before.startAt ||
        +row.blockEndAt !== +before.blockEndAt
      )
        fail('This booking changed. Reload and try again.');
      row.priceSnapshot = decode(row.priceSnapshot);
      const snapshot = {
        ...structuredClone(row),
        client: structuredClone(await tx.client(row.clientId)),
      };
      const now = clock();
      const result = await run(tx, row, now);
      if (!result?.reused)
        await tx.audit({
          adminId: actor.id,
          entity: 'booking',
          entityId: id,
          action: input.action,
          before: snapshot,
          after: {
            ...(await tx.bookingById(id)),
            client: await tx.client(row.clientId),
            operation: {
              amountCents: input.amountCents,
              paymentId: input.paymentId,
              method: input.method,
              note: input.note,
            },
          },
          ip: actor.ip,
        });
      return result;
    });
  }
  async function noOpenPayment(tx, row) {
    if (
      (await tx.attempts(row.id)).some((a) =>
        ['creating', 'open'].includes(a.status),
      )
    )
      fail(
        'A card checkout is open. Cancel or finish that checkout before editing this booking.',
      );
    if ((await tx.proofs(row.id)).some((p) => p.status === 'pending'))
      fail('Review the pending payment proof before editing this booking.');
    if (
      (await tx.bookingJobs(row.id)).some(
        (job) =>
          job.type === 'refundConflict' &&
          ['pending', 'failed'].includes(job.status),
      )
    )
      fail('A refund is still processing. Try again after it is reconciled.');
  }
  async function cancelJobs(tx, row) {
    for (const job of await tx.bookingJobs(row.id)) {
      if (
        ['email', 'reminder', 'winback'].includes(job.type) &&
        ['pending', 'failed'].includes(job.status)
      )
        await tx.saveJob(job.id, { status: 'cancelled' });
    }
  }
  async function ensureCapacity(tx, row, now) {
    const schedule = await tx.schedule(row.startAt, row.blockEndAt);
    const catalog = await tx.catalog();
    const capacity = remainingCapacity(
      DateTime.fromJSDate(row.startAt),
      DateTime.fromJSDate(row.blockEndAt),
      schedule.bookings.filter((b) => b.id !== row.id),
      catalog.settings.booking.capacity,
      now,
    );
    if (
      capacity < 1 ||
      schedule.timeBlocks.some(
        (block) => block.startAt < row.blockEndAt && block.endAt > row.startAt,
      )
    )
      fail(
        'This chair is no longer available. Reschedule the booking before confirming.',
        'SLOT_TAKEN',
      );
  }
  async function queue(tx, row, template, now, input) {
    await tx.queueJob({
      type: 'email',
      payload: {
        bookingId: row.id,
        template,
        ...(template === 'refund-receipt'
          ? { amountCents: input.amountCents }
          : {}),
      },
      dedupeKey: `admin:${template}:${row.id}:${input.requestKey}`,
      runAt: now.toJSDate(),
      status: 'pending',
    });
  }
  return {
    async adminEdit(id, input, actor) {
      return locked(
        id,
        actor,
        { ...input, action: 'edit' },
        async (tx, row, now) => {
          await noOpenPayment(tx, row);
          if (!['confirmed', 'pending_payment'].includes(row.status))
            fail('Only active appointments can be edited.');
          if (
            row.status === 'pending_payment' &&
            row.holdExpiresAt <= now.toJSDate()
          )
            fail('This booking hold has expired. Create a new appointment.');
          if (
            input.expectedUpdatedAt &&
            +new Date(input.expectedUpdatedAt) !== +row.updatedAt
          )
            fail(
              'This booking changed. Reload before saving.',
              'STALE_BOOKING',
            );
          const price = input.changeStyle
            ? priceBooking(await tx.catalog(), {
                ...input,
                paymentChoice: 'deposit',
              })
            : row.priceSnapshot;
          if (input.quotedTotalCents !== undefined) {
            if (!price.consultation)
              fail(
                'A custom total is only available for a consultation-priced style.',
              );
            price.consultation = false;
            price.subtotalCents = input.quotedTotalCents;
            price.depositCents = Math.min(
              price.depositCents,
              price.subtotalCents,
            );
            price.stylePriceCents =
              price.subtotalCents -
              price.addons.reduce((sum, a) => sum + a.priceCents, 0);
            if (price.stylePriceCents < 0)
              fail('The total must cover the selected extras.');
          }
          const paymentChoice =
            row.paymentChoice === 'full' && price.consultation
              ? 'deposit'
              : row.paymentChoice;
          if (input.changeStyle || input.quotedTotalCents !== undefined) {
            price.dueTodayCents =
              paymentChoice === 'full'
                ? price.subtotalCents
                : price.depositCents;
            price.balanceAfterPaymentCents = price.consultation
              ? null
              : price.subtotalCents - price.dueTodayCents;
          }
          if (price.subtotalCents < row.paidCents)
            fail(
              'The new total is below the amount paid. Record the refund first.',
            );
          const start = DateTime.fromISO(input.startAt, {
            setZone: true,
          }).setZone(ZONE);
          if (!start.isValid || start <= now)
            fail('Choose a future date and time.');
          const catalog = await tx.catalog();
          const settings = structuredClone(catalog.settings);
          // Owners may accept short-notice bookings; opening hours, step,
          // duration, buffer, blocks and capacity are still mandatory.
          settings.booking.minNoticeHours = 0;
          settings.booking.maxAdvanceDays = 3650;
          const schedule = await tx.schedule(
            start.startOf('day').toJSDate(),
            start.plus({ days: 1 }).startOf('day').toJSDate(),
          );
          const slot = daySlots({
            date: start.toISODate(),
            durationMin: price.durationMin,
            settings,
            bookings: schedule.bookings.filter((b) => b.id !== id),
            timeBlocks: schedule.timeBlocks,
            now,
          }).find((s) => +new Date(s.startAt) === start.toMillis());
          if (!slot?.available)
            fail(
              'That time is unavailable. Choose another date or time.',
              'SLOT_TAKEN',
            );
          await tx.updateClient(row.clientId, {
            name: input.name,
            email: input.email,
            phoneE164: input.phone,
          });
          await save(
            tx,
            row,
            {
              startAt: new Date(slot.startAt),
              endAt: new Date(slot.endAt),
              blockEndAt: new Date(slot.blockEndAt),
              clientNotes: input.notes,
              adminNotes: input.adminNotes,
              styleId: price.styleId,
              styleVariantId: price.styleVariantId,
              priceSnapshot: price,
              subtotalCents: price.subtotalCents,
              depositCents: price.depositCents,
              paymentChoice,
            },
            now,
          );
          if (input.changeStyle) await tx.replaceAddons(id, price.addons);
          Object.assign(row, {
            priceSnapshot: price,
            subtotalCents: price.subtotalCents,
          });
          await reconcile(tx, row, now);
          await cancelJobs(tx, row);
          if (input.notifyClient)
            await queue(tx, row, 'booking-rescheduled', now, input);
          return { saved: true };
        },
      );
    },
    async adminAction(id, input, actor) {
      return locked(id, actor, input, async (tx, row, now) => {
        if (input.action === 'note') {
          await save(tx, row, { adminNotes: input.note }, now);
        } else if (['balance-link', 'resend'].includes(input.action)) {
          if (!['confirmed', 'completed'].includes(row.status))
            fail(
              'Confirm the appointment before sending a payment or confirmation link.',
            );
          if (
            input.action === 'balance-link' &&
            (row.priceSnapshot.consultation || row.balanceCents <= 0)
          )
            fail('There is no known balance to pay.');
          await queue(
            tx,
            row,
            input.action === 'resend'
              ? 'booking-confirmation'
              : 'balance-payment',
            now,
            input,
          );
        } else if (input.action === 'payment') {
          const old = await tx.paymentByRequest(input.requestKey);
          if (old) {
            if (
              old.bookingId !== id ||
              old.amountCents !== input.amountCents ||
              old.method !== input.method
            )
              fail('Payment request has changed. Reload and try again.');
            return { reused: true };
          }
          await noOpenPayment(tx, row);
          if (
            !['confirmed', 'completed', 'pending_payment'].includes(row.status)
          )
            fail('This booking cannot accept a payment.');
          if (
            row.status === 'pending_payment' &&
            row.holdExpiresAt <= now.toJSDate()
          )
            fail('The hold has expired. Create a new booking.');
          if (input.amountCents > row.balanceCents)
            fail('The payment exceeds the outstanding balance.');
          if (
            row.status === 'pending_payment' &&
            input.amountCents + row.paidCents < row.depositCents
          )
            fail('Record at least the deposit to confirm this appointment.');
          if (row.status === 'pending_payment')
            await ensureCapacity(tx, row, now);
          await tx.insertPayment({
            adminRequestKey: input.requestKey,
            bookingId: id,
            type: row.paidCents
              ? 'balance'
              : input.amountCents >= row.subtotalCents
                ? 'full'
                : 'deposit',
            provider: 'manual',
            method: input.method,
            amountCents: input.amountCents,
            note: input.note,
            recordedByAdminId: actor.id,
            createdAt: now.toJSDate(),
          });
          await reconcile(tx, row, now);
          if (
            row.status === 'pending_payment' &&
            (await tx.bookingById(id)).paidCents >= row.depositCents
          )
            await change(tx, row, 'confirmed', now);
          await queue(tx, row, 'payment-receipt', now, input);
        } else if (input.action === 'refund') {
          const jobs = await tx.bookingJobs(id);
          const key = `admin-refund:${id}:${input.requestKey}`;
          if (jobs.some((job) => job.dedupeKey === key))
            return { reused: true };
          if (await tx.paymentByRequest(input.requestKey))
            return { reused: true };
          await noOpenPayment(tx, row);
          const payments = await tx.payments(id);
          const original = payments.find(
            (p) => p.id === input.paymentId && p.type !== 'refund',
          );
          if (!original) fail('Choose the original payment to refund.');
          const refunded = payments
            .filter(
              (p) =>
                p.type === 'refund' &&
                (original.provider === 'stripe'
                  ? p.stripePaymentIntentId === original.stripePaymentIntentId
                  : p.note?.startsWith(`Refund of payment ${original.id}.`)),
            )
            .reduce((sum, p) => sum + p.amountCents, 0);
          if (input.amountCents > original.amountCents - refunded)
            fail('The refund exceeds the remaining payment.');
          if (original.provider === 'manual') {
            await tx.insertPayment({
              adminRequestKey: input.requestKey,
              bookingId: id,
              type: 'refund',
              provider: 'manual',
              method: original.method,
              amountCents: input.amountCents,
              note: `Refund of payment ${original.id}. ${input.note}`,
              recordedByAdminId: actor.id,
              createdAt: now.toJSDate(),
            });
            await reconcile(tx, row, now);
            await queue(tx, row, 'refund-receipt', now, input);
          } else {
            const batch = await tx.batchByIntent(
              original.stripePaymentIntentId,
            );
            await tx.queueJob({
              type: 'refundConflict',
              payload: {
                bookingId: id,
                paymentIntentId: original.stripePaymentIntentId,
                amountCents: batch
                  ? refunded + input.amountCents
                  : input.amountCents,
                ...(batch ? { batchId: batch.id } : {}),
              },
              dedupeKey: key,
              runAt: now.toJSDate(),
              status: 'pending',
            });
          }
        } else {
          await noOpenPayment(tx, row);
          const status = {
            confirm: 'confirmed',
            cancel: 'cancelled',
            complete: 'completed',
            'no-show': 'no_show',
          }[input.action];
          if (!status) fail('Invalid booking action.');
          if (row.status === status) return { reused: true };
          if (
            status === 'confirmed' &&
            (row.status !== 'pending_payment' ||
              row.holdExpiresAt <= now.toJSDate())
          )
            fail('The booking hold has expired. Create a new appointment.');
          if (
            ['completed', 'no_show'].includes(status) &&
            row.startAt > now.toJSDate()
          )
            fail('The appointment has not started yet.');
          if (status === 'confirmed') await ensureCapacity(tx, row, now);
          await change(tx, row, status, now);
          await save(
            tx,
            row,
            {
              ...(status === 'cancelled'
                ? { cancelledAt: now.toJSDate(), cancelReason: input.note }
                : {}),
              ...(status === 'completed'
                ? { completedAt: now.toJSDate() }
                : {}),
              ...(status === 'confirmed'
                ? {
                    paymentChoice: row.paidCents ? row.paymentChoice : 'none',
                    holdExpiresAt: null,
                  }
                : {}),
            },
            now,
          );
          await cancelJobs(tx, row);
          if (['confirmed', 'cancelled'].includes(status))
            await queue(
              tx,
              row,
              `booking-${status === 'confirmed' ? 'confirmation' : 'cancelled'}`,
              now,
              input,
            );
        }
        return { saved: true };
      });
    },
  };
}
