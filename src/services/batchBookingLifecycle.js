import { DateTime } from 'luxon';
import { payableBalance } from './paymentEligibility.js';
import { BookingError } from './bookingErrors.js';
import { remainingCapacity } from './availabilityService.js';

const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
const itemsOf = (batch) => decode(batch.items);
const intentOf = (object) =>
  typeof object.payment_intent === 'string'
    ? object.payment_intent
    : object.payment_intent?.id;
const fail = (message) => {
  throw new BookingError('PAYMENTS_CHANGED', message, 409);
};

// Used only by bookingService: all booking mutations use its locked state,
// transition and reconciliation helpers, including combined-payment allocations.
export function batchBookingLifecycle(
  repository,
  { lockedMany, save, change, reconcile, queue },
) {
  async function applyRefunds(tx, batch, rows, refunds, now) {
    const items = itemsOf(batch).map((item) => ({ ...item }));
    const ledger = new Map();
    for (const row of rows)
      ledger.set(
        row.id,
        (await tx.payments(row.id)).filter(
          (p) =>
            p.stripePaymentIntentId === batch.stripePaymentIntentId &&
            p.type === 'refund',
        ),
      );
    for (const refund of [...refunds].sort(
      (a, b) => (a.created || 0) - (b.created || 0) || a.id.localeCompare(b.id),
    )) {
      if (refund.status !== 'succeeded') continue;
      if (
        refund.currency !== 'usd' ||
        !Number.isSafeInteger(refund.amount) ||
        refund.amount <= 0 ||
        (intentOf(refund) && intentOf(refund) !== batch.stripePaymentIntentId)
      )
        throw new BookingError(
          'INVALID_REFUND',
          'Combined refund needs reconciliation.',
          400,
        );
      let remaining =
        refund.amount -
        [...ledger.values()]
          .flat()
          .filter((p) => p.stripeRefundId === refund.id)
          .reduce((sum, p) => sum + p.amountCents, 0);
      if (remaining <= 0) continue;
      const target =
        refund.metadata?.application === 'mado-braidz' &&
        refund.metadata?.batchId === batch.id
          ? Number(refund.metadata.bookingId)
          : null;
      if (target && !items.some((i) => i.bookingId === target))
        throw new BookingError(
          'INVALID_REFUND',
          'Refund booking mismatch.',
          400,
        );
      const allocations = target
        ? items.filter((i) => i.bookingId === target)
        : items;
      for (const item of allocations) {
        const old = ledger
          .get(item.bookingId)
          .reduce((sum, p) => sum + p.amountCents, 0);
        const amount = Math.min(remaining, item.amountCents - old);
        if (amount <= 0) continue;
        const payment = {
          bookingId: item.bookingId,
          type: 'refund',
          provider: 'stripe',
          method: 'card',
          amountCents: amount,
          stripePaymentIntentId: batch.stripePaymentIntentId,
          stripeRefundId: refund.id,
        };
        await tx.insertPayment(payment);
        ledger.get(item.bookingId).push(payment);
        remaining -= amount;
        if (!remaining) break;
      }
      if (remaining)
        throw new BookingError(
          'INVALID_REFUND',
          'Refund exceeds its booking allocation.',
          400,
        );
      if (!target)
        await tx.notify({
          type: 'batch_refund_review',
          title: 'Combined refund allocated',
          body: `${batch.id}: external refund ${refund.id} allocated in booking order. Verify the allocation.`,
          url: '/admin/bookings',
        });
    }
    for (const item of items) {
      item.refundedCents = ledger
        .get(item.bookingId)
        .reduce((sum, p) => sum + p.amountCents, 0);
      await reconcile(
        tx,
        rows.find((row) => row.id === item.bookingId),
        now,
      );
    }
    await tx.saveBatch(batch.id, { items });
  }
  return {
    async reservePaymentBatch(ids, id, expectations) {
      if (!/^batch-[a-f0-9]{32}$/.test(id) || new Set(ids).size < 2)
        fail('Choose at least two pending payments.');
      return lockedMany(ids, async (tx, rows, now) => {
        const previous = await tx.batch(id);
        if (previous) {
          if (
            JSON.stringify(
              itemsOf(previous)
                .map((i) => i.bookingId)
                .sort((a, b) => a - b),
            ) !== JSON.stringify(rows.map((r) => r.id))
          )
            fail('Please search again.');
          return previous;
        }
        const expiresAt = now
          .plus({ minutes: 30, seconds: 10 })
          .startOf('second')
          .toJSDate();
        const items = [];
        for (const booking of rows) {
          const initial =
            booking.status === 'pending_payment' &&
            booking.holdExpiresAt > now.toJSDate();
          const balance =
            ['confirmed', 'completed'].includes(booking.status) &&
            payableBalance(booking) &&
            booking.balanceCents > 0 &&
            !booking.priceSnapshot.consultation;
          if (!initial && !balance)
            fail('A payment changed. Please search again.');
          if ((await tx.proofs(booking.id)).some((p) => p.status === 'pending'))
            fail(
              'A transfer is awaiting owner review. Please do not pay it again.',
            );
          if (
            (await tx.attempts(booking.id)).some(
              (a) =>
                ['creating', 'open'].includes(a.status) &&
                a.expiresAt > now.toJSDate(),
            )
          )
            fail(
              'A card checkout is already open for one appointment. Finish it or wait for it to expire.',
            );
          const type = initial ? booking.paymentChoice : 'balance';
          const amountCents = initial
            ? booking.priceSnapshot.dueTodayCents
            : booking.balanceCents;
          if (expectations) {
            const expected = expectations.find(
              (item) => item.ref === booking.ref,
            );
            if (
              !expected ||
              expected.amountCents !== amountCents ||
              expected.kind !== (initial ? 'initial' : 'balance')
            )
              fail(
                'A payment changed. Please search again to review the updated amount.',
              );
          }
          if (!Number.isSafeInteger(amountCents) || amountCents < 50)
            fail('A payment amount needs review.');
          const attemptId = `${id}-${booking.id}`;
          await tx.insertAttempt({
            id: attemptId,
            bookingId: booking.id,
            batchId: id,
            paymentType: type,
            amountCents,
            status: 'creating',
            expiresAt,
            createdAt: now.toJSDate(),
          });
          if (initial)
            await save(tx, booking, { holdExpiresAt: expiresAt }, now);
          items.push({
            bookingId: booking.id,
            ref: booking.ref,
            attemptId,
            type,
            amountCents,
            refundedCents: 0,
            refundDueCents: 0,
          });
        }
        const totalCents = items.reduce(
          (sum, item) => sum + item.amountCents,
          0,
        );
        if (!Number.isSafeInteger(totalCents) || totalCents > 99999999)
          fail('Please pay these appointments separately.');
        const batch = {
          id,
          items,
          totalCents,
          status: 'creating',
          expiresAt,
          createdAt: now.toJSDate(),
        };
        await tx.insertBatch(batch);
        return batch;
      });
    },
    async attachPaymentBatch(id, session) {
      const initial = await repository.batch(id);
      if (!initial)
        throw new BookingError('NOT_FOUND', 'Combined payment not found.', 404);
      return lockedMany(
        itemsOf(initial).map((i) => i.bookingId),
        async (tx, rows, now) => {
          const batch = await tx.batch(id);
          if (batch.stripeSessionId && batch.stripeSessionId !== session.id)
            fail('Payment session mismatch.');
          if (batch.status === 'paid') return;
          const expiresAt = new Date(session.expires_at * 1000);
          await tx.saveBatch(id, {
            stripeSessionId: session.id,
            expiresAt,
            status: session.status === 'expired' ? 'expired' : 'open',
          });
          for (const item of itemsOf(batch)) {
            await tx.saveAttempt(item.attemptId, {
              status: session.status === 'expired' ? 'expired' : 'open',
              expiresAt,
            });
            const row = rows.find((r) => r.id === item.bookingId);
            if (item.type !== 'balance' && row.status === 'pending_payment')
              await save(tx, row, { holdExpiresAt: expiresAt }, now);
          }
        },
      );
    },
    async expirePaymentBatch(id, status = 'expired') {
      const initial = await repository.batch(id);
      if (!initial) return;
      return lockedMany(
        itemsOf(initial).map((i) => i.bookingId),
        async (tx, rows, now) => {
          const batch = await tx.batch(id);
          if (batch.status === 'paid') return;
          await tx.saveBatch(id, { status: 'expired' });
          for (const item of itemsOf(batch)) {
            await tx.saveAttempt(item.attemptId, { status: 'expired' });
            const row = rows.find((r) => r.id === item.bookingId);
            if (item.type !== 'balance' && row.status === 'pending_payment')
              await change(tx, row, status, now);
          }
        },
      );
    },
    async applyBatchStripeEvent(event) {
      const object = event.data.object;
      const initial = await repository.batch(object.metadata?.batchId);
      if (!initial)
        throw new BookingError('NOT_FOUND', 'Combined payment not found.', 400);
      return lockedMany(
        itemsOf(initial).map((i) => i.bookingId),
        async (tx, rows, now) => {
          const batch = await tx.batch(initial.id);
          const record = await tx.event(event.id, event.type, now.toJSDate());
          if (record.processedAt) return { bookingIds: rows.map((r) => r.id) };
          if (
            object.metadata?.application !== 'mado-braidz' ||
            object.metadata?.batchId !== batch.id ||
            (batch.stripeSessionId && batch.stripeSessionId !== object.id)
          )
            throw new BookingError(
              'INVALID_PAYMENT',
              'Combined payment metadata mismatch.',
              400,
            );
          if (
            object.currency !== 'usd' ||
            object.amount_total !== batch.totalCents
          )
            throw new BookingError(
              'INVALID_PAYMENT',
              'Combined payment amount mismatch.',
              400,
            );
          const paid =
            [
              'checkout.session.completed',
              'checkout.session.async_payment_succeeded',
            ].includes(event.type) && object.payment_status === 'paid';
          if (paid && batch.status !== 'paid') {
            const intent = intentOf(object);
            if (!intent)
              throw new BookingError(
                'INVALID_PAYMENT',
                'Missing payment intent.',
                400,
              );
            const other = await tx.batchByIntent(intent);
            if (other && other.id !== batch.id)
              throw new BookingError(
                'INVALID_PAYMENT',
                'Duplicate payment intent.',
                400,
              );
            if (await tx.paymentByIntent(intent))
              throw new BookingError(
                'INVALID_PAYMENT',
                'Payment intent is already recorded.',
                400,
              );
            const items = itemsOf(batch).map((i) => ({ ...i }));
            for (const item of items) {
              const row = rows.find((r) => r.id === item.bookingId);
              const attempt = await tx.attempt(item.attemptId);
              if (attempt?.batchId !== batch.id)
                throw new BookingError(
                  'INVALID_PAYMENT',
                  'Combined payment allocation mismatch.',
                  400,
                );
              await tx.insertPayment({
                bookingId: row.id,
                type: item.type,
                provider: 'stripe',
                method: event.paymentMethod || 'card',
                amountCents: item.amountCents,
                stripePaymentIntentId: intent,
              });
              await tx.saveAttempt(item.attemptId, { status: 'paid' });
              let refund = 0;
              if (item.type === 'balance')
                refund = ['confirmed', 'completed'].includes(row.status)
                  ? Math.max(0, item.amountCents - row.balanceCents)
                  : item.amountCents;
              else if (['pending_payment', 'expired'].includes(row.status)) {
                const schedule = await tx.schedule(row.startAt, row.blockEndAt),
                  catalog = await tx.catalog();
                const free =
                  remainingCapacity(
                    DateTime.fromJSDate(row.startAt),
                    DateTime.fromJSDate(row.blockEndAt),
                    schedule.bookings.filter((b) => b.id !== row.id),
                    catalog.settings.booking.capacity,
                    now,
                  ) > 0;
                const blocked = schedule.timeBlocks.some(
                  (b) => b.startAt < row.blockEndAt && b.endAt > row.startAt,
                );
                const conflict =
                  !free || blocked || row.startAt <= now.toJSDate();
                await change(
                  tx,
                  row,
                  conflict ? 'payment_conflict' : 'confirmed',
                  now,
                );
                if (conflict) refund = item.amountCents;
                else await queue(tx, row, 'booking-confirmation', now);
              } else {
                refund = item.amountCents;
                if (row.status === 'cancelled')
                  await change(tx, row, 'payment_conflict', now);
              }
              await reconcile(tx, row, now);
              if (item.type === 'balance' && !refund)
                await queue(tx, row, 'balance-receipt', now);
              item.refundDueCents = refund;
              if (refund) {
                await tx.queueJob({
                  type: 'refundConflict',
                  payload: {
                    batchId: batch.id,
                    bookingId: row.id,
                    paymentIntentId: intent,
                    amountCents: refund,
                  },
                  dedupeKey: `refund:${batch.id}:${row.id}:${refund}`,
                  runAt: now.toJSDate(),
                  status: 'pending',
                });
                await queue(tx, row, 'payment-conflict', now);
              }
              await tx.notify({
                type: refund ? 'payment_conflict' : 'booking_paid',
                title: refund
                  ? 'Combined payment needs refund'
                  : 'Appointment payment received',
                body: row.ref,
                url: `/admin/bookings/${row.id}`,
              });
            }
            await tx.saveBatch(batch.id, {
              status: 'paid',
              stripeSessionId: object.id,
              stripePaymentIntentId: intent,
              items,
            });
          } else if (
            [
              'checkout.session.expired',
              'checkout.session.async_payment_failed',
            ].includes(event.type) &&
            batch.status !== 'paid'
          ) {
            await tx.saveBatch(batch.id, { status: 'expired' });
            for (const item of itemsOf(batch)) {
              await tx.saveAttempt(item.attemptId, { status: 'expired' });
              const row = rows.find((r) => r.id === item.bookingId);
              if (item.type !== 'balance' && row.status === 'pending_payment')
                await change(tx, row, 'expired', now);
            }
          }
          await tx.finishEvent(event.id, now.toJSDate());
          return { bookingIds: rows.map((r) => r.id) };
        },
      );
    },
    async applyBatchRefundEvent(event, batchId, refunds) {
      const initial = await repository.batch(batchId);
      return lockedMany(
        itemsOf(initial).map((i) => i.bookingId),
        async (tx, rows, now) => {
          const record = await tx.event(event.id, event.type, now.toJSDate());
          if (record.processedAt) return;
          const batch = await tx.batch(batchId);
          if (batch.status !== 'paid')
            throw new BookingError(
              'INVALID_REFUND',
              'Payment is not recorded yet.',
              409,
            );
          await applyRefunds(tx, batch, rows, refunds, now);
          await tx.finishEvent(event.id, now.toJSDate());
        },
      );
    },
    async finishBatchRefund(job, refund) {
      const payload = decode(job.payload),
        initial = await repository.batch(payload.batchId);
      return lockedMany(
        itemsOf(initial).map((i) => i.bookingId),
        async (tx, rows, now) => {
          const batch = await tx.batch(initial.id);
          if (refund) await applyRefunds(tx, batch, rows, [refund], now);
          await tx.saveJob(job.id, {
            status:
              !refund || refund.status === 'succeeded' ? 'done' : 'pending',
            payload: { ...payload, ...(refund ? { refundId: refund.id } : {}) },
            attempts: job.attempts + 1,
            lastError: null,
          });
        },
      );
    },
  };
}
