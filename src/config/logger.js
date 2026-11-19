import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync } from 'node:fs';
export function createLogger(config) {
  if (config.NODE_ENV === 'test') return pino({ level: 'silent' });
  mkdirSync(config.LOG_DIR, { recursive: true });
  return pino(
    {
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers["x-mado-webhook-secret"]',
        'res.headers.set-cookie',
        'password',
        'DATABASE_URL',
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'BREVO_API_KEY',
        'WHATSAPP_ACCESS_TOKEN',
        'CALLMEBOT_API_KEY',
        'BREVO_WEBHOOK_SECRET',
        'VAPID_PRIVATE_KEY',
        'TURNSTILE_SECRET_KEY',
        'turnstileToken',
        'req.body["cf-turnstile-response"]',
        'manageToken',
        'req.query.session_id',
        'req.params.token',
        'req.headers["x-csrf-token"]',
      ],
    },
    createStream('app.log', {
      path: config.LOG_DIR,
      interval: '1d',
      maxFiles: 14,
    }),
  );
}
