import 'dotenv/config';
import { z } from 'zod';
const optional = z.string().default('');
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    APP_URL: z.url().default('http://localhost:4780'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4780),
    SESSION_SECRET: z.string().min(32),
    DATABASE_URL: z
      .url()
      .refine((value) => value.startsWith('mysql://'), 'Must be a MySQL URL'),
    STRIPE_SECRET_KEY: optional,
    STRIPE_PUBLISHABLE_KEY: optional,
    STRIPE_WEBHOOK_SECRET: optional,
    MANUAL_PAYMENT_NAME: z.string().default('Magdaline Arrey'),
    ZELLE_RECIPIENT: optional,
    CASHAPP_CASHTAG: optional,
    MANUAL_REVIEW_HOURS: z.coerce.number().int().min(1).max(48).default(24),
    EMAIL_PROVIDER: z.enum(['resend', 'postmark', 'log']).default('log'),
    RESEND_API_KEY: optional,
    EMAIL_FROM: z
      .string()
      .default('Mado African Braidz <bookings@madoafricanbraidz.com>'),
    ADMIN_ALERT_EMAILS: optional,
    VAPID_PUBLIC_KEY: optional,
    VAPID_PRIVATE_KEY: optional,
    TURNSTILE_SITE_KEY: optional,
    TURNSTILE_SECRET_KEY: optional,
    UPLOAD_DIR: z.string().min(1),
    CRON_SECRET: optional,
    ADMIN_EMAIL: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.email().optional(),
    ),
    ADMIN_PASSWORD: z.preprocess(
      (value) => (value === '' ? undefined : value),
      z.string().min(12).optional(),
    ),
    LOG_DIR: z.string().default('logs'),
  })
  .superRefine((env, ctx) => {
    if (env.STRIPE_SECRET_KEY || env.STRIPE_PUBLISHABLE_KEY) {
      const secret = env.STRIPE_SECRET_KEY.match(/^sk_(test|live)_/);
      const publishable = env.STRIPE_PUBLISHABLE_KEY.match(/^pk_(test|live)_/);
      if (!secret)
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'Use a valid Stripe secret key',
        });
      if (!publishable)
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_PUBLISHABLE_KEY'],
          message: 'Use a valid Stripe publishable key',
        });
      if (secret && publishable && secret[1] !== publishable[1])
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_PUBLISHABLE_KEY'],
          message: 'Stripe key modes must match',
        });
      if (secret?.[1] === 'live' && env.NODE_ENV !== 'production')
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'Use Stripe test keys outside production',
        });
    }
    if (env.NODE_ENV === 'production') {
      for (const key of [
        'STRIPE_SECRET_KEY',
        'STRIPE_PUBLISHABLE_KEY',
        'STRIPE_WEBHOOK_SECRET',
        'TURNSTILE_SITE_KEY',
        'TURNSTILE_SECRET_KEY',
        'CRON_SECRET',
      ]) {
        if (!env[key])
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Required in production',
          });
      }
      if (!env.APP_URL.startsWith('https://'))
        ctx.addIssue({
          code: 'custom',
          path: ['APP_URL'],
          message: 'HTTPS required in production',
        });
      if (env.EMAIL_PROVIDER === 'resend' && !env.RESEND_API_KEY)
        ctx.addIssue({
          code: 'custom',
          path: ['RESEND_API_KEY'],
          message: 'Required for Resend',
        });
    }
  });
export function parseEnv(source = process.env) {
  return envSchema.parse(source);
}
