import express from 'express';
export function stripeWebhook(provider, payments, config, notifications) {
  const router = express.Router();
  router.post(
    '/',
    express.raw({ type: 'application/json', limit: '1mb' }),
    async (req, res) => {
      if (!provider || !payments || !config.STRIPE_WEBHOOK_SECRET)
        return res.status(503).json({ error: 'WEBHOOK_UNAVAILABLE' });
      let event;
      try {
        event = provider.constructEvent(
          req.body,
          req.headers['stripe-signature'],
        );
      } catch {
        return res.status(400).json({ error: 'INVALID_SIGNATURE' });
      }
      try {
        await payments.handleEvent(event);
        res.json({ received: true });
      } catch (error) {
        if (notifications)
          await notifications.repository
            .webhookFailure(event.id)
            .catch(() => {});
        req.log.error(
          { eventId: event.id, code: error.code || error.cause?.code },
          'Stripe event needs retry',
        );
        res
          .status(error.status === 400 ? 400 : 503)
          .json({ error: 'EVENT_PROCESSING_FAILED' });
      }
    },
  );
  return router;
}
