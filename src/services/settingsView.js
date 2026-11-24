import { DateTime } from 'luxon';

const ZONE = 'America/New_York';
const et = (value) => DateTime.fromJSDate(new Date(value), { zone: ZONE });
// One line per block, with a run of days shown as one entry.
export function groupBlocks(blocks) {
  const groups = new Map();
  for (const block of blocks) {
    const range = block.repeatRule?.startsWith('range:');
    const key = range ? block.repeatRule : 'block:' + block.id;
    groups.set(key, [...(groups.get(key) || []), block]);
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0],
      last = rows.at(-1);
    const start = et(first.startAt),
      end = et(first.endAt);
    const allDay =
      start.toFormat('HH:mm') === '00:00' && end.toFormat('HH:mm') === '00:00';
    const day = (value) => et(value).toFormat('ccc, LLL d, yyyy');
    return {
      id: first.id,
      range: rows.length > 1,
      weekly: Boolean(first.repeatRule?.startsWith('weekly:')),
      label:
        rows.length > 1
          ? `${et(first.startAt).toFormat('ccc, LLL d')} – ${day(last.startAt)}`
          : day(first.startAt),
      detail:
        (allDay
          ? 'All day'
          : `${start.toFormat('h:mm a')} – ${end.toFormat('h:mm a')} ET`) +
        (first.repeatRule?.startsWith('weekly:') ? ' · Weekly' : ''),
      reason: first.reason,
    };
  });
}
const ago = (value) =>
  value ? et(value).toFormat("ccc, LLL d 'at' h:mm a") + ' ET' : null;
export function healthChecks(health, config) {
  const list = [];
  const add = (name, state, text) => list.push({ name, state, text });
  add('Website and database', 'good', 'This page loaded, so both are working.');
  const card = Boolean(
    config.STRIPE_SECRET_KEY && config.STRIPE_WEBHOOK_SECRET,
  );
  const live = config.STRIPE_SECRET_KEY?.startsWith('sk_live_');
  add(
    'Card payments',
    !card ? 'bad' : config.NODE_ENV === 'production' && !live ? 'bad' : 'good',
    !card
      ? 'Not set up.'
      : `Stripe is in ${live ? 'live' : 'test'} mode. ${health.lastCardEvent ? `Last message from Stripe: ${ago(health.lastCardEvent)}.` : 'No messages from Stripe yet.'}`,
  );
  add(
    'Zelle and Cash App',
    config.ZELLE_RECIPIENT || config.CASHAPP_CASHTAG ? 'good' : 'info',
    [
      config.ZELLE_RECIPIENT ? 'Zelle is set up' : 'Zelle is not set up',
      config.CASHAPP_CASHTAG ? 'Cash App is set up' : 'Cash App is not set up',
    ].join('. ') + '.',
  );
  add(
    'Email',
    !config.EMAIL_ENABLED || config.EMAIL_PROVIDER === 'log'
      ? 'bad'
      : health.emailsFailed
        ? 'bad'
        : 'good',
    !config.EMAIL_ENABLED || config.EMAIL_PROVIDER === 'log'
      ? 'Email is switched off on this site.'
      : health.emailsFailed
        ? `${health.emailsFailed} of ${health.emailsSent} emails had a problem in the last 24 hours.`
        : `${health.emailsSent} sent in the last 24 hours, with no problems. ${health.lastEmail ? `Last email: ${ago(health.lastEmail)}.` : ''}`,
  );
  const quiet =
    health.lastRun && Date.now() - new Date(health.lastRun) > 20 * 60000;
  const ran = health.lastRun ? ` Last ran ${ago(health.lastRun)}.` : '';
  add(
    'Reminders and timed tasks',
    quiet || health.late || health.failed
      ? 'bad'
      : health.lastRun
        ? 'good'
        : 'info',
    (quiet
      ? 'The server timer has stopped, so reminders are not going out. Tell your website support.'
      : health.failed
        ? `${health.failed} task${health.failed === 1 ? '' : 's'} failed in the last 24 hours and will be tried again where possible.`
        : health.late
          ? `${health.late} task${health.late === 1 ? ' is' : 's are'} waiting longer than usual.`
          : health.lastRun
            ? 'The timer is running and nothing is late.'
            : 'Waiting for the first timed run.') + ran,
  );
  add(
    'Alerts on your phone or computer',
    !config.VAPID_PUBLIC_KEY ? 'info' : health.alertDevices ? 'good' : 'info',
    !config.VAPID_PUBLIC_KEY
      ? 'Push alerts are not set up.'
      : health.alertDevices
        ? `${health.alertDevices} device${health.alertDevices === 1 ? '' : 's'} receive alerts.`
        : 'No device receives alerts yet. Switch them on in Notifications.',
  );
  return list;
}
