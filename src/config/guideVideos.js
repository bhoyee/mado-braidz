// Owner guide videos, one per admin page. Paste the YouTube link (an Unlisted
// video is fine) in place of SAMPLE. Pages still on SAMPLE show their guide
// locally for testing, but never on the live site.
export const SAMPLE = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';

// The first match wins, so put longer paths before shorter ones.
export const guideVideos = [
  { path: '/bookings/new', title: 'New appointment', video: SAMPLE },
  { path: '/bookings/*/edit', title: 'Edit an appointment', video: SAMPLE },
  { path: '/bookings/*', title: 'Appointment details', video: SAMPLE },
  { path: '/bookings', title: 'Appointments', video: SAMPLE },
  { path: '/payment-reviews', title: 'Payment reviews', video: SAMPLE },
  { path: '/balances', title: 'Balances outstanding', video: SAMPLE },
  { path: '/payments', title: 'Payments received', video: SAMPLE },
  { path: '/calendar', title: 'Calendar', video: SAMPLE },
  { path: '/styles/*', title: 'Edit a style', video: SAMPLE },
  { path: '/styles', title: 'Styles & prices', video: SAMPLE },
  { path: '/addons', title: 'Extras', video: SAMPLE },
  { path: '/gallery', title: 'Photos & Our Work', video: SAMPLE },
  { path: '/clients/*', title: 'Client details', video: SAMPLE },
  { path: '/clients', title: 'Clients', video: SAMPLE },
  { path: '/availability', title: 'Opening hours', video: SAMPLE },
  { path: '/time-off', title: 'Time off', video: SAMPLE },
  { path: '/email-templates', title: 'Email wording', video: SAMPLE },
  { path: '/settings/*', title: 'Settings', video: SAMPLE },
  { path: '/seo', title: 'Search & AI', video: SAMPLE },
  {
    path: '/settings?tab=security',
    title: 'Sign-in & security',
    video: SAMPLE,
  },
  { path: '/settings', title: 'Studio details', video: SAMPLE },
  { path: '/notifications', title: 'Notifications', video: SAMPLE },
  { path: '/', title: 'Overview', video: SAMPLE },
];

// Accepts the links YouTube gives: watch, share, Shorts, live and embed.
export function youtubeId(link) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, '');
  if (url.protocol !== 'https:') return null;
  let id = null;
  if (host === 'youtu.be') id = url.pathname.slice(1);
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com')
    id =
      url.pathname === '/watch'
        ? url.searchParams.get('v')
        : url.pathname.match(/^\/(?:embed|shorts|live)\/([^/]+)/)?.[1];
  return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? id : null;
}

function matches(pattern, path, tab) {
  const [route, query] = pattern.split('?');
  if (query && query !== `tab=${tab}`) return false;
  const want = route.split('/'),
    have = path.split('/');
  return (
    want.length === have.length &&
    want.every((part, i) => part === have[i] || (part === '*' && have[i]))
  );
}

export function guideFor(path, tab, production, guides = guideVideos) {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const guide = guides.find((item) => matches(item.path, clean, tab));
  const id = guide && youtubeId(guide.video);
  if (!id || (production && guide.video === SAMPLE)) return null;
  return { id, title: guide.title };
}
