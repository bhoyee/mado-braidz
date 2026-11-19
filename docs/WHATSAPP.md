# WhatsApp chat and owner alerts

These are separate features. Both are optional and configured in the private `.env`.

## Public chat button

Set `WHATSAPP_NUMBER` to the salon's WhatsApp number in international format with no spaces, for example `+14437434979`. Restart the app after changing it. Leaving it empty hides the button. The button opens WhatsApp with a short booking enquiry; the visitor chooses whether to send it. It requires no messaging API account and does not automatically send booking alerts.

## Automated owner alerts

### CallMeBot: owner-only notifications

Use `WHATSAPP_PROVIDER=callmebot` for the owner's own activated WhatsApp number. CallMeBot documents this self-notification use case in its [shop-owner notification guide](https://www.callmebot.com/blog/whatsapp-messages-from-shopify/). It must not be used to send client messages.

1. From the receiving WhatsApp number, follow the [current activation instructions](https://www.callmebot.com/blog/free-api-whatsapp-messages/). Use the bot contact listed there; availability/contact details can change.
2. Send the activation phrase `I allow callmebot to send me messages` and wait for the API key.
3. Add the key to private `.env` as `CALLMEBOT_API_KEY`; never put it in chat or Git.
4. Set `WHATSAPP_OWNER_NUMBER` to that activated number, `WHATSAPP_PROVIDER=callmebot`, a fresh `WHATSAPP_ALERTS_START_AT` UTC timestamp, and `WHATSAPP_ALERTS_ENABLED=true` only after a successful owner test.
5. Restart the app. The existing cron sends new booking confirmations and payment-review alerts only to that recipient. Email and Web Push remain independent backups.

Changing to the owner's US number requires activating the US number with CallMeBot and replacing **both** `WHATSAPP_OWNER_NUMBER` and `CALLMEBOT_API_KEY`. Changing the public `WHATSAPP_NUMBER` affects the chat button only. No Meta sender ID, token, template approval or paid messaging account is required for the CallMeBot adapter.

CallMeBot's API requires credentials in an HTTPS query. The app never logs this request URL or stores provider response bodies, which may echo credentials. Success is stored as `callmebot:accepted`; this means queued/sent by CallMeBot, not confirmed receipt on the owner's phone. Unknown/time-out outcomes stop automatic retries to avoid duplicate alerts. Confirm actual receipt before enabling unattended sending.

If CallMeBot reports that the receiving account is paused, follow its account-specific instruction to send `resume` from the activated WhatsApp number to its bot contact. A paused account can return HTTP 208, so a 2xx response alone is not treated as delivery success. Wait for reactivation and verify a real test before enabling alerts.

### Meta provider (optional alternative)

The settings below apply only when `WHATSAPP_PROVIDER=meta`.

The integration uses [Meta WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/overview/). A normal WhatsApp app and phone number alone cannot authenticate the API. Set up a Business Platform sending number and token with messaging permission; confirm the owner's receiving number and opt-in, and review Meta's applicable messaging charges. Never put tokens in chat or Git.

Create and obtain approval for the template named by `WHATSAPP_TEMPLATE_NAME` (default `mado_owner_alert`) in the configured `WHATSAPP_TEMPLATE_LANGUAGE` (default `en_US`). Its body must have exactly three text parameters, in this order:

1. Event title, such as “A chair is booked” or “Payment proof needs review”.
2. Booking reference / event details.
3. The owner portal URL, which requires owner login.

Suggested template body:

```text
Studio update: {{1}}
{{2}}
Review in your owner portal: {{3}}
```

Meta decides template approval and category. Configure the exact approved template name and language; do not enable alerts before approval and a successful account test.

Required private settings:

```text
WHATSAPP_OWNER_NUMBER=+1...
WHATSAPP_PHONE_NUMBER_ID=<Meta sending phone-number ID, not a phone number>
WHATSAPP_ACCESS_TOKEN=<private token with messaging permission>
WHATSAPP_API_VERSION=v27.0
WHATSAPP_TEMPLATE_NAME=mado_owner_alert
WHATSAPP_TEMPLATE_LANGUAGE=en_US
WHATSAPP_ALERTS_START_AT=<current UTC ISO timestamp>
WHATSAPP_ALERTS_ENABLED=true
```

Use a fresh activation timestamp so historical events are not sent. The existing five-minute jobs cron sends new confirmed-booking and payment-review alerts to the configured owner, including bookings confirmed after Stripe payment or verified manual transfers. It does not send WhatsApp messages to clients. Changing `WHATSAPP_OWNER_NUMBER` and restarting changes the destination for future sends; it is separate from the public chat number.

Jobs use a unique notification ID to prevent resending successful alerts. Known provider rejections use existing bounded retries; uncertain network outcomes stop automatic retries and raise an owner-portal alert. If a job is interrupted while `sending`, check provider records before manually requeueing. Provider acceptance is not proof the message reached the phone; delivery webhooks are not implemented here. Verify a real alert on the owner's device before calling WhatsApp alerts enabled and tested. Existing email and Web Push continue independently.

Keep `WHATSAPP_ALERTS_ENABLED=false` until the owner has provided the account settings and verified receipt. Do not upload screenshots or customer contact information to WhatsApp for these alerts.
