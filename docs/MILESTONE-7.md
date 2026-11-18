# Milestone 7: notifications and emails

Postmark sends appointment emails using the `outbound` transactional stream. Opted-in return-visit emails use the separate `broadcast` stream. Keep the cPanel mailbox for replies. Email delivery stays disabled until domain authentication and an owner inbox test are verified.

## Configuration

Set `EMAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN`, `POSTMARK_MESSAGE_STREAM=outbound`, `POSTMARK_BROADCAST_STREAM=broadcast`, `EMAIL_FROM`, `EMAIL_REPLY_TO` and `ADMIN_ALERT_EMAILS` in the private server environment. Owner alert addresses saved in Settings take precedence over the environment fallback. Never commit tokens. Existing Resend password-reset compatibility is retained; the Milestone 7 queue uses Postmark.

Before enabling delivery, verify the sending domain in Postmark. Add its exact DKIM and custom Return-Path records through the authoritative DNS provider, check existing SPF and DMARC, and preserve cPanel’s inbound MX records. Do not add a second SPF TXT record. Authentication improves deliverability but does not guarantee inbox placement.

Set `POSTMARK_WEBHOOK_SECRET` to a random private value and register delivery, bounce, spam complaint and subscription-change webhooks using HTTP Basic authentication: username `postmark`, password this secret, destination `https://madoafricanbraidz.com/webhooks/postmark`. Postmark does not sign these callbacks. They are authenticated before processing and match the recipient and message/delivery key. Delivery updates cannot downgrade a bounce or complaint to delivered. Hard bounces and complaints suppress future sends; complaints and provider unsubscribe events remove marketing consent.

Set `NOTIFICATIONS_START_AT` to the UTC activation time (for example an ISO timestamp ending in `Z`) and `EMAIL_ENABLED=true` only after verification. Older queued client emails will not be released. Existing future appointments receive newly scheduled reminders; past completed visits do not receive a backlog of win-back messages. Restart the app after environment changes.

Use `EMAIL_PROVIDER=log` and `EMAIL_ENABLED=true` outside production to generate private `tmp/emails/*.html` and `.txt` previews without sending. Production cannot use the log provider for enabled delivery. The Contact form stays disabled while delivery is disabled; when enabled, it queues verified, rate-limited enquiries to the owner with the visitor as Reply-To.

## Cron and delivery

Run `npm run db:migrate`, `npm run build`, then the existing `node scripts/run-jobs.js` cron every five minutes. A MySQL `GET_LOCK('jobs',0)` prevents overlapping runs. There are no permanent workers. Each run sends at most 50 due jobs, with backoff and at most five attempts. Repeated jobs use delivery keys and email logs. An uncertain network outcome is held for owner review, rather than automatically sending a possible duplicate; check Postmark before retrying. Alerts do not expose customer details on the phone lock screen.

Reminder 1 defaults to 48 hours before the appointment. Reminder 2 is at 7am Eastern; visits starting at or before 7am receive it one hour before instead. Cancelled/rescheduled appointments are checked again before sending. Rebooking cancels pending return-visit jobs. Thank-you emails follow completion by three hours; win-back messages follow completion by 30, 60 and 90 local days, only with consent and no later booking. Marketing contains signed one-click unsubscribe headers and a preference page; opening the page alone does not unsubscribe.

## Owner portal

Notifications polls every 30 seconds and includes mark-as-read controls. Email Templates lets the owner edit subjects and introductions while preserving the layout and automatic appointment details. The test button queues a message only to the signed-in owner. Email delivery history remains in each appointment detail.

For push, generate a VAPID pair and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT=mailto:bookings@madoafricanbraidz.com`. Keep this pair stable across releases. Open Notifications and choose **Enable push on this device**. On iPhone/iPad, first add the owner portal to the Home Screen and open it there. Browser support and permission are required. The owner PWA has no offline caching of private pages or customer data. Revoked/expired subscriptions are removed after provider responses.

## Acceptance checks

- Unit and request tests cover Eastern-time/DST scheduling, cancellation/rescheduling, consent, rebooking, unsubscribe, provider streams/headers, signing secrets, retry behaviour and calendar attachments.
- MySQL tests verify migrations, duplicate delivery keys, callback ordering/suppression and durable unsubscribe.
- Browser checks verify owner pages, auth, template editing, notification read state, Contact gating and PWA assets at phone/desktop widths.
- Before declaring live delivery complete: verify DNS, send a real owner test, inspect delivery/authentication and inbox placement, then verify a phone receives a push alert.
