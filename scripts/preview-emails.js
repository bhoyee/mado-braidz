// Local design preview with sample data. Never reads the database or sends mail.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { renderEmail } from '../src/services/emailService.js';
import { tokenHash, accessToken } from '../src/services/bookingService.js';
import { emailTemplates } from '../src/services/emailTemplates.js';
import {
  awaitingReview,
  cardDeposit,
  proofOf,
  sampleDetail,
} from '../tests/fixtures/bookingEmail.js';

const config = {
  APP_URL: 'http://localhost:4780',
  SESSION_SECRET: 'preview-only-not-a-real-secret-value',
};
const dir = 'tmp/email-preview';
await mkdir(dir, { recursive: true });
const logo =
  'data:image/png;base64,' +
  (await readFile('public/img/email-logo.png')).toString('base64');
const links = [];
async function save(file, title, payload, detail, extras) {
  const email = await renderEmail(config, payload, detail, {}, extras);
  await writeFile(
    `${dir}/${file}.html`,
    email.html.replace(/src="[^"]*email-logo\.png"/g, `src="${logo}"`),
  );
  await writeFile(`${dir}/${file}.txt`, email.text);
  links.push(
    `<li><a href="${file}.html">${title}</a><br>${email.subject.replace(/[<>&]/g, '')}</li>`,
  );
}
const owner = (kind, detail, extras) => [
  { template: 'admin-alert', body: 'Sample', url: '/admin/bookings/7' },
  null,
  { visits: 1, ...extras, alert: { kind, detail } },
];
await save(
  'owner-card',
  'Owner: card booking',
  ...owner('booking_confirmed', sampleDetail(), { payments: cardDeposit }),
);
for (const [key, name] of [
  ['zelle', 'Zelle'],
  ['cashapp', 'Cash App'],
])
  await save(
    `owner-${key}`,
    `Owner: ${name} review`,
    ...owner('payment_review', sampleDetail(awaitingReview), {
      proof: proofOf(key),
    }),
  );
await save(
  'owner-balance-zelle',
  'Owner: Zelle balance review',
  ...owner('payment_review', sampleDetail(), {
    proof: proofOf('zelle', { paymentType: 'balance', amountCents: 19000 }),
  }),
);
await save(
  'owner-rescheduled',
  'Owner: rescheduled',
  ...owner('booking_rescheduled', sampleDetail(), { payments: cardDeposit }),
);
await save(
  'owner-cancelled',
  'Owner: cancelled',
  ...owner(
    'booking_cancelled',
    sampleDetail({ status: 'cancelled', cancelReason: 'Client request' }),
    { payments: cardDeposit },
  ),
);
for (const template of [
  'payment-submitted',
  'payment-rejected',
  'booking-confirmation',
  'booking-rescheduled',
  'booking-cancelled',
  'reminder-48',
  'reminder-morning',
  'deposit-payment',
  'balance-payment',
  'payment-receipt',
  'refund-receipt',
  'payment-conflict',
  'thank-you',
]) {
  const detail = sampleDetail({
    ...(['deposit-payment', 'payment-submitted'].includes(template)
      ? awaitingReview
      : {}),
    ...(['booking-cancelled', 'payment-rejected'].includes(template)
      ? { status: 'cancelled' }
      : {}),
    ...(template === 'payment-conflict' ? { status: 'payment_conflict' } : {}),
  });
  detail.booking.manageTokenHash = tokenHash(
    accessToken(detail.booking.ref, config.SESSION_SECRET),
  );
  await save(
    'customer-' + template,
    'Customer: ' + emailTemplates[template].subject,
    { template, amountCents: 3000, method: 'zelle', paymentType: 'deposit' },
    detail,
    template === 'payment-submitted'
      ? { payments: [], proof: proofOf('zelle') }
      : {
          payments: template === 'deposit-payment' ? [] : cardDeposit,
          now: new Date(
            template === 'reminder-morning'
              ? '2026-12-05T12:00:00Z'
              : '2026-12-03T15:00:00Z',
          ),
        },
  );
}
await writeFile(
  `${dir}/index.html`,
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Email previews</title><body style="font:16px Arial;max-width:640px;margin:24px auto;padding:0 16px"><h1>Email previews</h1><p>Sample data. Nothing was sent.</p><ul>${links.join('')}</ul>`,
);
console.log(`Open ${dir}/index.html`);
