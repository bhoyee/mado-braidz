import Stripe from 'stripe';
import { createBookingService, tokenHash } from './bookingService.js';
import { BookingError } from './bookingErrors.js';
export function createStripeProvider(config) {
  if (!config.STRIPE_SECRET_KEY) return null;
  const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
    maxNetworkRetries: 2,
    timeout: 15000,
  });
  return {
    createSession: (params, key) =>
      stripe.checkout.sessions.create(params, { idempotencyKey: key }),
    retrieveSession: (id) => stripe.checkout.sessions.retrieve(id),
    expireSession: (id) => stripe.checkout.sessions.expire(id),
    constructEvent: (body, signature) =>
      stripe.webhooks.constructEvent(
        body,
        signature,
        config.STRIPE_WEBHOOK_SECRET,
      ),
    async inspectPayment(id) {
      const intent = await stripe.paymentIntents.retrieve(id, {
        expand: ['latest_charge'],
      });
      return {
        method: intent.latest_charge?.payment_method_details?.type,
        refunded: intent.latest_charge?.amount_refunded || 0,
      };
    },
    async refund(payload, key) {
      if (payload.refundId) {
        const existing = await stripe.refunds.retrieve(payload.refundId);
        if (existing.status === 'succeeded') {
          const intent = await stripe.paymentIntents.retrieve(
            payload.paymentIntentId,
            { expand: ['latest_charge'] },
          );
          existing.cumulativeAmountRefunded =
            intent.latest_charge.amount_refunded;
        }
        if (['failed', 'canceled'].includes(existing.status))
          throw new BookingError(
            'REFUND_REVIEW_REQUIRED',
            'Refund needs manual review.',
            503,
          );
        return existing;
      }
      const before = await stripe.paymentIntents.retrieve(
        payload.paymentIntentId,
        { expand: ['latest_charge'] },
      );
      const charge = before.latest_charge;
      const remaining = charge.amount - charge.amount_refunded;
      if (remaining === 0) {
        const pending = charge.refunds?.data?.find(
          (refund) =>
            refund.status === 'pending' || refund.status === 'requires_action',
        );
        if (pending) return pending;
        return {
          id: charge.refunds?.data?.[0]?.id,
          status: 'succeeded',
          cumulativeAmountRefunded: charge.amount_refunded,
        };
      }
      const refund = payload.refundId
        ? await stripe.refunds.retrieve(payload.refundId)
        : await stripe.refunds.create(
            {
              payment_intent: payload.paymentIntentId,
              amount: Math.min(payload.amountCents, remaining),
              reason: 'requested_by_customer',
            },
            { idempotencyKey: key },
          );
      if (refund.status === 'succeeded') {
        const intent = await stripe.paymentIntents.retrieve(
          payload.paymentIntentId,
          { expand: ['latest_charge'] },
        );
        refund.cumulativeAmountRefunded = intent.latest_charge.amount_refunded;
      }
      return refund;
    },
  };
}
export function createPaymentService(repository, provider, config, clock) {
  const bookings = createBookingService(
    repository,
    clock,
    config.SESSION_SECRET,
  );
  const origin = config.APP_URL.replace(/\/$/, '');
  async function authorize(ref, token) {
    const booking = await repository.bookingByRef(ref);
    if (!booking || !token || booking.manageTokenHash !== tokenHash(token))
      throw new BookingError('NOT_FOUND', 'Booking not found.', 404);
    return booking;
  }
  async function checkout(ref, token, balance = false, returnPath = null) {
    if (!provider)
      throw new BookingError(
        'PAYMENT_UNAVAILABLE',
        'Online payment is unavailable. Please call the studio.',
        503,
      );
    const booking = await authorize(ref, token);
    const attempts = await repository.attempts(booking.id);
    if (
      !balance &&
      ['confirmed', 'completed', 'payment_conflict'].includes(booking.status)
    ) {
      const paid = attempts.find((a) => a.status === 'paid');
      if (paid)
        return {
          url: `${origin}/book/success?session_id=${encodeURIComponent(paid.stripeSessionId)}`,
          sessionId: paid.stripeSessionId,
        };
    }
    const type = balance ? 'balance' : booking.paymentChoice;
    const {
      booking: locked,
      attempt,
      client,
    } = await bookings.reserveCheckout(booking.id, type);
    let session;
    if (attempt.stripeSessionId) {
      session = await provider.retrieveSession(attempt.stripeSessionId);
      if (
        returnPath &&
        (session.customer_email ||
          /\/booking\/[a-f0-9]{64}/.test(session.cancel_url || ''))
      )
        throw new BookingError(
          'CHECKOUT_OPEN',
          'A card checkout is already open. Use your original booking link or call the studio.',
          409,
        );
    } else {
      const price = locked.priceSnapshot;
      const look = [
        price.styleName,
        price.size?.replaceAll('_', ' '),
        price.length?.replaceAll('_', ' '),
      ]
        .filter(Boolean)
        .join(', ');
      const name =
        type === 'deposit'
          ? `Booking deposit – ${look} (applied to your total)`
          : type === 'balance'
            ? `Remaining balance – ${look}`
            : look +
              (price.addons.length
                ? ' + ' + price.addons.map((a) => a.name).join(', ')
                : '');
      const metadata = {
        bookingId: String(booking.id),
        paymentType: type,
        attemptId: attempt.id,
        application: 'mado-braidz',
        bookingRef: booking.ref,
      };
      try {
        session = await provider.createSession(
          {
            mode: 'payment',
            adaptive_pricing: { enabled: false },
            automatic_tax: { enabled: false },
            ...(returnPath ? {} : { customer_email: client.email }),
            client_reference_id: String(booking.id),
            metadata,
            payment_intent_data: { metadata },
            line_items: [
              {
                price_data: {
                  currency: 'usd',
                  unit_amount: attempt.amountCents,
                  product_data: { name },
                },
                quantity: 1,
              },
            ],
            expires_at: Math.floor(attempt.expiresAt.getTime() / 1000),
            success_url:
              origin + '/book/success?session_id={CHECKOUT_SESSION_ID}',
            cancel_url:
              origin +
              (returnPath ||
                (balance
                  ? `/booking/${token}?cancel=1`
                  : `/book?resume=${encodeURIComponent(ref)}`)),
          },
          // Numeric IDs may repeat across local and disposable test databases.
          // Keep Stripe retries scoped to the globally unique booking reference.
          `${booking.ref}:${attempt.id}`,
        );
      } catch (error) {
        if (
          error.type === 'StripeInvalidRequestError' &&
          (error.param === 'expires_at' ||
            /expires_at.*at least 30 minutes/.test(error.message))
        ) {
          if (type !== 'balance')
            await bookings.releaseHold(booking.id, 'expired');
          throw new BookingError(
            'HOLD_EXPIRED',
            'Please choose your time again.',
            409,
          );
        }
        throw error;
      }
      await bookings.attachCheckout(booking.id, attempt.id, session);
    }
    if (session.status === 'expired')
      throw new BookingError(
        'HOLD_EXPIRED',
        'This payment session has expired. Choose another time.',
        409,
      );
    if (session.status === 'complete')
      return {
        url: `${origin}/book/success?session_id=${encodeURIComponent(session.id)}`,
        sessionId: session.id,
      };
    if (!/^https:\/\/checkout\.stripe\.com\//.test(session.url || ''))
      throw new BookingError(
        'INVALID_SESSION',
        'Could not open secure payment.',
        503,
      );
    return {
      url: session.url,
      sessionId: session.id,
      holdExpiresAt: new Date(session.expires_at * 1000).toISOString(),
    };
  }
  async function cancel(ref, token) {
    const booking = await authorize(ref, token);
    const attempts = await repository.attempts(booking.id);
    const attempt = attempts.find((a) => a.paymentType !== 'balance');
    if (attempt?.stripeSessionId && provider) {
      let session = await provider.retrieveSession(attempt.stripeSessionId);
      if (session.status === 'complete')
        return { paid: true, sessionId: session.id };
      if (session.status === 'open') {
        try {
          await provider.expireSession(session.id);
        } catch (error) {
          session = await provider.retrieveSession(session.id);
          if (session.status === 'complete')
            return { paid: true, sessionId: session.id };
          throw error;
        }
      }
    } else if (attempt?.status === 'creating')
      throw new BookingError(
        'CHECKOUT_PENDING',
        'Payment is opening. Please try again.',
        409,
      );
    await bookings.releaseHold(booking.id, 'cancelled');
    return { cancelled: true };
  }
  async function runRefunds(id) {
    if (!provider) return;
    for (const job of await repository.refundJobs(id)) {
      const payload =
        typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
      try {
        await bookings.finishRefund(
          job,
          await provider.refund(payload, job.dedupeKey),
        );
      } catch (error) {
        await repository.saveJob(job.id, {
          status: 'failed',
          attempts: job.attempts + 1,
          lastError: 'Stripe refund requires retry',
        });
        throw error;
      }
    }
  }
  return {
    checkout,
    cancel,
    authorize,
    runRefunds,
    async handleEvent(event) {
      const object = event.data.object;
      const intentId =
        typeof object.payment_intent === 'string'
          ? object.payment_intent
          : object.payment_intent?.id;
      let info;
      if (
        provider?.inspectPayment &&
        [
          'checkout.session.completed',
          'checkout.session.async_payment_succeeded',
        ].includes(event.type) &&
        object.payment_status === 'paid' &&
        (await repository.attemptBySession(object.id))
      ) {
        info = await provider.inspectPayment(
          typeof object.payment_intent === 'string'
            ? object.payment_intent
            : object.payment_intent.id,
        );
        event = {
          ...event,
          paymentMethod: ['card', 'cashapp'].includes(info.method)
            ? info.method
            : 'other',
        };
      }
      const result = await bookings.applyStripeEvent(event);
      if (result.bookingId && info?.refunded)
        await bookings.applyStripeEvent({
          id: `reconcile_${intentId}_${info.refunded}`,
          type: 'charge.refunded',
          data: {
            object: {
              object: 'charge',
              currency: object.currency,
              payment_intent: object.payment_intent,
              amount_refunded: info.refunded,
            },
          },
        });
      if (result.bookingId) await runRefunds(result.bookingId);
      return result;
    },
    async status(sessionId, token) {
      const attempt = await repository.attemptBySession(sessionId);
      if (!attempt)
        throw new BookingError('NOT_FOUND', 'Payment not found.', 404);
      const booking = await repository.bookingById(attempt.bookingId);
      await authorize(booking.ref, token);
      const price =
        typeof booking.priceSnapshot === 'string'
          ? JSON.parse(booking.priceSnapshot)
          : booking.priceSnapshot;
      return {
        ref: booking.ref,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        paidCents: booking.paidCents,
        balanceCents: price.consultation ? null : booking.balanceCents,
        startAt: booking.startAt.toISOString(),
        endAt: booking.endAt.toISOString(),
        styleName: price.styleName,
        manageUrl: `/booking/${token}`,
      };
    },
  };
}
