import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import nunjucks from 'nunjucks';
import { DateTime } from 'luxon';
import { emailTemplates } from './emailTemplates.js';
import { accessToken, tokenHash } from './bookingService.js';
import {
  bookingMailText,
  customerBookingMail,
  ownerBookingMail,
} from './bookingEmail.js';
import { seedData } from '../db/seed-data.js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
export const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export const unsubscribeToken = (client, secret) =>
  `${client.id}.${createHmac('sha256', secret).update(`unsubscribe:${client.id}:${client.email}`).digest('hex')}`;
export function validUnsubscribe(token, client, secret) {
  if (!client) return false;
  const expected = unsubscribeToken(client, secret);
  return (
    Buffer.byteLength(token) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  );
}
const money = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    (n || 0) / 100,
  );
const local = (date) =>
  DateTime.fromJSDate(new Date(date), { zone: 'America/New_York' }).toFormat(
    'cccc, LLLL d, yyyy · h:mm a',
  );
const cleanIcs = (v) =>
  String(v)
    .replace(/[\r\n]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
export function calendarAttachment(booking, business, appUrl) {
  const dt = (value) =>
    DateTime.fromJSDate(new Date(value), { zone: 'utc' }).toFormat(
      "yyyyMMdd'T'HHmmss'Z'",
    );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mado//Appointments//EN',
    'BEGIN:VEVENT',
    `UID:${booking.ref}@${new URL(appUrl).hostname}`,
    `DTSTAMP:${dt(new Date())}`,
    `DTSTART:${dt(booking.startAt)}`,
    `DTEND:${dt(booking.endAt)}`,
    `SUMMARY:${cleanIcs(booking.priceSnapshot.styleName)}`,
    `LOCATION:${cleanIcs([business.street, business.city, business.region, business.postalCode].filter(Boolean).join(', '))}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return {
    Name: `${booking.ref}.ics`,
    Content: Buffer.from(lines.join('\r\n') + '\r\n').toString('base64'),
    ContentType: 'text/calendar',
  };
}
export async function renderEmail(
  config,
  payload,
  detail,
  settings = {},
  { alert, ...extras } = {},
) {
  const def = emailTemplates[payload.template];
  if (!def) throw new Error('Unknown email template');
  const custom = settings.emailTemplates?.[payload.template] || {};
  const business = { ...seedData.settings.business, ...settings.business };
  const appUrl = config.APP_URL.replace(/\/$/, '');
  const { booking, client } = detail || {};
  const snapshot = booking?.priceSnapshot || {};
  const address = `${business.street}, ${business.city}, ${business.region} ${business.postalCode}`;
  let actionUrl = appUrl + '/book',
    actionLabel = 'Explore styles & book',
    text = '',
    directionsUrl;
  if (booking) {
    const token = accessToken(booking.ref, config.SESSION_SECRET);
    const canManage = tokenHash(token) === booking.manageTokenHash;
    actionUrl = canManage ? `${appUrl}/booking/${token}` : appUrl + '/pay';
    actionLabel = canManage ? 'View your visit' : 'Find your payment';
    text = `${client?.name || 'Your appointment'}\nReference: ${booking.ref}\nStyle: ${snapshot.styleName}\nWhen: ${local(booking.startAt)} Eastern\nAddress: ${address}\nAmount paid: ${money(booking.paidCents)}\nBalance: ${snapshot.consultation ? 'Agreed at consultation' : money(booking.balanceCents)}\n`;
    const directions =
      'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(address);
    directionsUrl = directions;
    text += `Directions: ${directions}\n`;
    if (payload.template.startsWith('winback')) {
      actionUrl = `${appUrl}/book?style=${encodeURIComponent(payload.styleSlug || '')}`;
      actionLabel = 'Choose your next visit';
    }
    if (
      payload.template === 'thank-you' &&
      /^https:\/\//.test(business.social?.google || '')
    ) {
      actionUrl = business.social.google;
      actionLabel = 'Leave a review';
    }
    if (payload.template === 'payment-conflict')
      text +=
        booking.paymentStatus === 'refunded'
          ? 'Refund recorded.\n'
          : 'Refund is processing.\n';
  }
  if (payload.template === 'admin-alert') {
    text = payload.body || 'A new studio update is ready.';
    actionUrl =
      appUrl +
      (payload.url?.startsWith('/admin')
        ? payload.url
        : '/admin/notifications');
    actionLabel = 'Open owner studio';
  }
  if (payload.template === 'daily-agenda') {
    text = payload.agenda || 'No confirmed appointments today.';
    actionUrl = appUrl + '/admin/calendar';
    actionLabel = 'Open calendar';
  }
  if (payload.template === 'contact-enquiry')
    text = `Name: ${payload.name}\nEmail: ${payload.email}\n\n${payload.message}`;
  if (
    payload.template === 'refund-receipt' &&
    Number.isSafeInteger(payload.amountCents)
  )
    text += `\nRefund amount: ${money(payload.amountCents)}\n`;
  if (payload.template === 'password-reset') {
    actionUrl = payload.resetUrl;
    actionLabel = 'Reset owner password';
  }
  const marketing = payload.template.startsWith('winback');
  const preferencesUrl = client
    ? `${appUrl}/unsubscribe/${unsubscribeToken(client, config.SESSION_SECRET)}`
    : appUrl + '/contact';
  let content = escapeHtml(text).replace(/\n/g, '<br />');
  if (directionsUrl)
    content = content.replace(
      `Directions: ${escapeHtml(directionsUrl)}`,
      `<a href="${escapeHtml(directionsUrl)}" style="color:#5f2d9e;font-weight:bold">Get directions</a>`,
    );
  const vars = {
    subject: custom.subject || def.subject,
    intro: custom.intro || def.intro,
    content,
    actionUrl,
    actionLabel,
    appUrl,
    logoUrl: `${(/^https:\/\//.test(business.url || '') ? business.url : appUrl).replace(/\/$/, '')}/img/email-logo.png`,
    address,
    street: business.street,
    locality: `${business.city}, ${business.region} ${business.postalCode}`,
    country: business.country === 'US' ? 'United States' : business.country,
    businessName:
      business.name === 'Mado African Braidz'
        ? 'Mado African Braids'
        : business.name || 'Mado African Braids',
    phone:
      parsePhoneNumberFromString(
        business.phone || '',
        'US',
      )?.formatNational() || business.phone,
    phoneHref: business.phone,
    preferencesUrl,
    marketing,
    footer: marketing
      ? 'You received this because you opted in to salon news. You can unsubscribe below.'
      : booking
        ? 'Your deposit is applied to your total. Contact the studio if you need help with your visit.'
        : 'Questions? Reply to this email or call the studio.',
  };
  const customSubject = Boolean(
    custom.subject && custom.subject !== def.subject,
  );
  const mail =
    payload.template === 'admin-alert'
      ? alert &&
        ownerBookingMail(alert.kind, alert.detail, extras, appUrl, payload)
      : booking
        ? customerBookingMail(
            payload.template,
            detail,
            extras,
            {
              subject: vars.subject,
              intro: vars.intro,
              customSubject,
              action: { label: actionLabel, href: actionUrl },
              business,
              settings,
              directions: directionsUrl,
              bookUrl: appUrl + '/book',
              payUrl: appUrl + '/pay',
            },
            payload,
          )
        : null;
  const template = await readFile(
    new URL(
      mail
        ? '../views/emails/booking.html.njk'
        : '../views/emails/layout.html.njk',
      import.meta.url,
    ),
    'utf8',
  );
  const html = new nunjucks.Environment(null, {
    autoescape: true,
  }).renderString(template, { ...vars, mail });
  if (mail) vars.subject = mail.subject;
  const body = mail
    ? `${bookingMailText(mail)}\n${vars.businessName}\n${address}\n${vars.phone}`
    : `${vars.subject}\n\n${vars.intro}\n\n${text}\n${actionLabel}: ${actionUrl}\n\n${vars.footer}\n${vars.businessName}\n${address}\n${vars.phone}${marketing ? '\nUnsubscribe: ' + preferencesUrl : ''}`;
  return {
    subject: vars.subject,
    html,
    text: body,
    marketing,
    replyTo:
      payload.template === 'contact-enquiry'
        ? payload.email
        : config.EMAIL_REPLY_TO,
    headers: marketing
      ? [
          { Name: 'List-Unsubscribe', Value: `<${preferencesUrl}>` },
          {
            Name: 'List-Unsubscribe-Post',
            Value: 'List-Unsubscribe=One-Click',
          },
        ]
      : [],
    attachments:
      booking &&
      ['booking-confirmation', 'booking-rescheduled'].includes(payload.template)
        ? [calendarAttachment(booking, business, appUrl)]
        : [],
  };
}
export function createEmailService(config, fetcher = fetch) {
  return {
    async send(to, email, key) {
      if (config.EMAIL_PROVIDER === 'log') {
        if (config.NODE_ENV === 'production')
          throw new Error('Preview email cannot be sent in production');
        await mkdir('tmp/emails', { recursive: true });
        const name = createHash('sha256').update(key).digest('hex');
        await writeFile(`tmp/emails/${name}.html`, email.html, { mode: 0o600 });
        await writeFile(`tmp/emails/${name}.txt`, email.text, { mode: 0o600 });
        return `preview-${name}`;
      }
      if (!config.EMAIL_ENABLED) throw new Error('Email delivery disabled');
      if (config.EMAIL_PROVIDER !== 'brevo')
        throw new Error('Configure Brevo for email delivery');
      const match = config.EMAIL_FROM.match(/^\s*(.*?)\s*<([^<>]+)>\s*$/);
      const sender = match
        ? { name: match[1].trim(), email: match[2].trim() }
        : { email: config.EMAIL_FROM.trim() };
      let response;
      try {
        response = await fetcher('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'api-key': config.BREVO_API_KEY,
          },
          body: JSON.stringify({
            sender,
            to: [{ email: to }],
            subject: email.subject,
            htmlContent: email.html,
            textContent: email.text,
            replyTo:
              email.replyTo || config.EMAIL_REPLY_TO
                ? { email: email.replyTo || config.EMAIL_REPLY_TO }
                : undefined,
            attachment: email.attachments?.length
              ? email.attachments.map((item) => ({
                  name: item.Name,
                  content: item.Content,
                }))
              : undefined,
            tags: [email.marketing ? 'mado-return-visit' : 'mado-appointment'],
            headers: {
              ...Object.fromEntries(
                (email.headers || []).map((item) => [item.Name, item.Value]),
              ),
              IdempotencyKey: key,
              'X-Mailin-custom': 'deliveryKey:' + key,
            },
          }),
        });
      } catch {
        const error = new Error(
          'Delivery outcome is unknown; verify in Brevo before retrying',
        );
        error.uncertain = true;
        throw error;
      }
      if (!response.ok)
        throw new Error('Brevo rejected email (' + response.status + ')');
      let result;
      try {
        result = await response.json();
      } catch {
        const error = new Error(
          'Brevo response was incomplete; verify delivery before retrying',
        );
        error.uncertain = true;
        throw error;
      }
      if (!result.messageId) {
        const error = new Error('Brevo acceptance needs verification');
        error.uncertain = true;
        throw error;
      }
      return result.messageId.replace(/^<|>$/g, '');
    },
  };
}
