import { sql } from 'drizzle-orm';
import {
  mysqlTable,
  bigint,
  varchar,
  text,
  int,
  boolean,
  json,
  datetime,
  date,
  mysqlEnum,
  primaryKey,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core';
const id = () =>
  bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey();
const ref = (name) => bigint(name, { mode: 'number', unsigned: true });
const dt = (name) => datetime(name, { fsp: 3, mode: 'date' });
const created = () =>
  dt('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`);
const str = (name, length = 255) => varchar(name, { length });
export const admins = mysqlTable('admins', {
  id: id(),
  email: str('email').notNull().unique(),
  name: str('name').notNull(),
  passwordHash: str('password_hash').notNull(),
  role: mysqlEnum('role', ['owner', 'staff']).notNull(),
  totpSecret: str('totp_secret'),
  totpLastStep: bigint('totp_last_step', { mode: 'number' }),
  authVersion: int('auth_version').notNull().default(0),
  failedAttempts: int('failed_attempts').notNull().default(0),
  lockedUntil: dt('locked_until'),
  resetTokenHash: str('reset_token_hash', 64),
  resetExpiresAt: dt('reset_expires_at'),
  lastLoginAt: dt('last_login_at'),
  createdAt: created(),
});
export const sessions = mysqlTable('sessions', {
  sessionId: varchar('session_id', { length: 128 }).primaryKey(),
  expires: int('expires', { unsigned: true }).notNull(),
  data: text('data').notNull(),
});
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  value: json('value').notNull(),
  updatedBy: ref('updated_by').references(() => admins.id),
  updatedAt: dt('updated_at').notNull(),
});
export const styleCategories = mysqlTable('style_categories', {
  id: id(),
  name: str('name').notNull(),
  slug: str('slug').notNull().unique(),
  sort: int('sort').notNull().default(0),
});
export const redirects = mysqlTable('redirects', {
  id: id(),
  source: str('source', 512).notNull().unique(),
  target: str('target', 512).notNull(),
  updatedAt: dt('updated_at').notNull(),
});
export const styles = mysqlTable('styles', {
  id: id(),
  categoryId: ref('category_id')
    .notNull()
    .references(() => styleCategories.id),
  name: str('name').notNull(),
  slug: str('slug').notNull().unique(),
  shortDesc: text('short_desc'),
  longDesc: text('long_desc'),
  durationMin: int('duration_min').notNull().default(240),
  priceOnConsultation: boolean('price_on_consultation')
    .notNull()
    .default(false),
  fromPriceCents: int('from_price_cents'),
  featured: boolean('featured').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sort: int('sort').notNull().default(0),
  seoTitle: str('seo_title'),
  seoDescription: text('seo_description'),
  createdAt: created(),
  updatedAt: dt('updated_at').notNull(),
});
export const styleVariants = mysqlTable(
  'style_variants',
  {
    id: id(),
    styleId: ref('style_id')
      .notNull()
      .references(() => styles.id),
    size: mysqlEnum('size', ['medium', 'semi_medium', 'small']),
    length: mysqlEnum('length', [
      'shoulder',
      'mid_back',
      'waist',
      'top_butt',
      'butt',
      'under_butt',
    ]),
    label: str('label'),
    priceCents: int('price_cents').notNull(),
    durationMin: int('duration_min'),
    active: boolean('active').notNull().default(true),
    sort: int('sort').notNull().default(0),
  },
  (t) => [uniqueIndex('style_size_length').on(t.styleId, t.size, t.length)],
);
export const addons = mysqlTable('addons', {
  id: id(),
  name: str('name').notNull(),
  slug: str('slug').notNull().unique(),
  description: text('description'),
  priceCents: int('price_cents').notNull(),
  durationMin: int('duration_min').notNull().default(0),
  appliesToAll: boolean('applies_to_all').notNull().default(true),
  active: boolean('active').notNull().default(true),
  sort: int('sort').notNull().default(0),
});
export const addonStyles = mysqlTable(
  'addon_styles',
  {
    addonId: ref('addon_id')
      .notNull()
      .references(() => addons.id),
    styleId: ref('style_id')
      .notNull()
      .references(() => styles.id),
  },
  (t) => [primaryKey({ columns: [t.addonId, t.styleId] })],
);
export const media = mysqlTable('media', {
  id: id(),
  styleId: ref('style_id').references(() => styles.id),
  kind: mysqlEnum('kind', ['style', 'gallery', 'inspiration']).notNull(),
  path: str('path', 1024).notNull(),
  variants: json('variants'),
  width: int('width'),
  height: int('height'),
  alt: text('alt').notNull(),
  sort: int('sort').notNull().default(0),
});
export const clients = mysqlTable(
  'clients',
  {
    id: id(),
    name: str('name').notNull(),
    email: str('email').notNull(),
    phoneE164: str('phone_e164', 32).notNull(),
    marketingConsent: boolean('marketing_consent').notNull().default(false),
    consentAt: dt('consent_at'),
    unsubscribedAt: dt('unsubscribed_at'),
    notes: text('notes'),
    createdAt: created(),
  },
  (t) => [
    index('client_email').on(t.email),
    index('client_phone').on(t.phoneE164),
  ],
);
export const bookings = mysqlTable(
  'bookings',
  {
    id: id(),
    ref: str('ref', 32).notNull().unique(),
    clientId: ref('client_id')
      .notNull()
      .references(() => clients.id),
    styleId: ref('style_id')
      .notNull()
      .references(() => styles.id),
    styleVariantId: ref('style_variant_id').references(() => styleVariants.id),
    startAt: dt('start_at').notNull(),
    endAt: dt('end_at').notNull(),
    blockEndAt: dt('block_end_at').notNull(),
    status: mysqlEnum('status', [
      'pending_payment',
      'confirmed',
      'completed',
      'cancelled',
      'no_show',
      'expired',
      'payment_conflict',
    ]).notNull(),
    paymentStatus: mysqlEnum('payment_status', [
      'unpaid',
      'deposit_paid',
      'paid_in_full',
      'refunded',
      'partially_refunded',
    ]).notNull(),
    paymentChoice: mysqlEnum('payment_choice', [
      'deposit',
      'full',
      'manual',
      'none',
    ]).notNull(),
    source: mysqlEnum('source', ['web', 'admin']).notNull(),
    holdExpiresAt: dt('hold_expires_at'),
    priceSnapshot: json('price_snapshot').notNull(),
    subtotalCents: int('subtotal_cents').notNull(),
    depositCents: int('deposit_cents').notNull(),
    paidCents: int('paid_cents').notNull().default(0),
    balanceCents: int('balance_cents').notNull(),
    clientNotes: text('client_notes'),
    adminNotes: text('admin_notes'),
    inspirationMediaId: ref('inspiration_media_id').references(() => media.id),
    manageTokenHash: str('manage_token_hash', 64).notNull(),
    policyAcceptedAt: dt('policy_accepted_at'),
    stripeCheckoutSessionId: str('stripe_checkout_session_id'),
    checkoutRequestKey: str('checkout_request_key', 64).unique(),
    createdByAdminId: ref('created_by_admin_id').references(() => admins.id),
    completedAt: dt('completed_at'),
    cancelledAt: dt('cancelled_at'),
    cancelReason: text('cancel_reason'),
    createdAt: created(),
    updatedAt: dt('updated_at').notNull(),
  },
  (t) => [
    index('booking_start').on(t.startAt),
    index('booking_status_start').on(t.status, t.startAt),
  ],
);
export const bookingAddons = mysqlTable(
  'booking_addons',
  {
    bookingId: ref('booking_id')
      .notNull()
      .references(() => bookings.id),
    addonId: ref('addon_id')
      .notNull()
      .references(() => addons.id),
    nameSnapshot: str('name_snapshot').notNull(),
    priceCents: int('price_cents').notNull(),
    durationMin: int('duration_min').notNull(),
  },
  (t) => [primaryKey({ columns: [t.bookingId, t.addonId] })],
);
export const calendarLocks = mysqlTable('calendar_locks', {
  date: date('date', { mode: 'string' }).primaryKey(),
});
export const timeBlocks = mysqlTable('time_blocks', {
  id: id(),
  startAt: dt('start_at').notNull(),
  endAt: dt('end_at').notNull(),
  reason: text('reason'),
  repeatRule: str('repeat_rule'),
  createdBy: ref('created_by')
    .notNull()
    .references(() => admins.id),
});
export const payments = mysqlTable('payments', {
  id: id(),
  adminRequestKey: str('admin_request_key', 64).unique(),
  bookingId: ref('booking_id')
    .notNull()
    .references(() => bookings.id),
  type: mysqlEnum('type', ['deposit', 'full', 'balance', 'refund']).notNull(),
  provider: mysqlEnum('provider', ['stripe', 'manual']).notNull(),
  method: mysqlEnum('method', [
    'card',
    'cash',
    'zelle',
    'cashapp',
    'other',
  ]).notNull(),
  amountCents: int('amount_cents').notNull(),
  stripePaymentIntentId: str('stripe_payment_intent_id'),
  stripeRefundId: str('stripe_refund_id'),
  note: text('note'),
  recordedByAdminId: ref('recorded_by_admin_id').references(() => admins.id),
  createdAt: created(),
});
export const paymentProofs = mysqlTable('payment_proofs', {
  id: id(),
  bookingId: ref('booking_id')
    .notNull()
    .references(() => bookings.id),
  method: mysqlEnum('method', ['zelle', 'cashapp']).notNull(),
  paymentType: mysqlEnum('payment_type', [
    'deposit',
    'full',
    'balance',
  ]).notNull(),
  amountCents: int('amount_cents').notNull(),
  path: str('path', 1024).notNull(),
  status: mysqlEnum('status', ['pending', 'approved', 'rejected'])
    .notNull()
    .default('pending'),
  reviewedBy: ref('reviewed_by').references(() => admins.id),
  reviewedAt: dt('reviewed_at'),
  reviewNote: text('review_note'),
  createdAt: created(),
});
export const stripeEvents = mysqlTable('stripe_events', {
  id: str('id').primaryKey(),
  type: str('type').notNull(),
  receivedAt: dt('received_at').notNull(),
  processedAt: dt('processed_at'),
});
export const checkoutAttempts = mysqlTable('checkout_attempts', {
  id: varchar('id', { length: 100 }).primaryKey(),
  bookingId: ref('booking_id')
    .notNull()
    .references(() => bookings.id),
  batchId: varchar('batch_id', { length: 64 }),
  paymentType: mysqlEnum('payment_type', [
    'deposit',
    'full',
    'balance',
  ]).notNull(),
  amountCents: int('amount_cents').notNull(),
  status: mysqlEnum('status', [
    'creating',
    'open',
    'paid',
    'expired',
  ]).notNull(),
  stripeSessionId: str('stripe_session_id').unique(),
  stripePaymentIntentId: str('stripe_payment_intent_id').unique(),
  expiresAt: dt('expires_at').notNull(),
  createdAt: created(),
});
export const paymentBatches = mysqlTable('payment_batches', {
  id: varchar('id', { length: 64 }).primaryKey(),
  items: json('items').notNull(),
  totalCents: int('total_cents').notNull(),
  status: mysqlEnum('status', [
    'creating',
    'open',
    'paid',
    'expired',
  ]).notNull(),
  stripeSessionId: str('stripe_session_id').unique(),
  stripePaymentIntentId: str('stripe_payment_intent_id').unique(),
  expiresAt: dt('expires_at').notNull(),
  createdAt: created(),
});
export const jobs = mysqlTable(
  'jobs',
  {
    id: id(),
    type: str('type').notNull(),
    payload: json('payload').notNull(),
    runAt: dt('run_at').notNull(),
    status: mysqlEnum('status', ['pending', 'done', 'failed', 'cancelled'])
      .notNull()
      .default('pending'),
    attempts: int('attempts').notNull().default(0),
    lastError: text('last_error'),
    dedupeKey: str('dedupe_key').unique(),
    createdAt: created(),
  },
  (t) => [index('job_status_run').on(t.status, t.runAt)],
);
export const emailLog = mysqlTable('email_log', {
  id: id(),
  deliveryKey: str('delivery_key').unique(),
  bookingId: ref('booking_id').references(() => bookings.id),
  clientId: ref('client_id').references(() => clients.id),
  template: str('template').notNull(),
  toEmail: str('to_email').notNull(),
  providerId: str('provider_id'),
  status: str('status').notNull(),
  createdAt: created(),
});
export const emailSuppressions = mysqlTable('email_suppressions', {
  email: str('email').primaryKey(),
  reason: str('reason').notNull(),
  createdAt: created(),
});
export const notifications = mysqlTable('notifications', {
  id: id(),
  adminId: ref('admin_id').references(() => admins.id),
  type: str('type').notNull(),
  title: str('title').notNull(),
  body: text('body').notNull(),
  url: str('url', 1024),
  readAt: dt('read_at'),
  createdAt: created(),
});
export const pushSubscriptions = mysqlTable('push_subscriptions', {
  id: id(),
  adminId: ref('admin_id')
    .notNull()
    .references(() => admins.id),
  endpoint: str('endpoint', 512).notNull().unique(),
  keys: json('keys').notNull(),
  createdAt: created(),
});
export const auditLog = mysqlTable('audit_log', {
  id: id(),
  adminId: ref('admin_id')
    .notNull()
    .references(() => admins.id),
  entity: str('entity').notNull(),
  entityId: ref('entity_id').notNull(),
  action: str('action').notNull(),
  before: json('before'),
  after: json('after'),
  ip: str('ip', 45),
  createdAt: created(),
});
