// Owner guide videos, one per admin page. Paste the YouTube link (an Unlisted
// video is fine) in place of SAMPLE. Pages still on SAMPLE show their guide
// locally for testing, but never on the live site.
export const SAMPLE = 'https://www.youtube.com/watch?v=M7lc1UVf-VE';

const VIDEOS = {
  overview: 'https://youtu.be/GTWGu7vsyeU',
  calendar: 'https://youtu.be/Vpn33EOpDv4',
  appointments: 'https://youtu.be/yvx4qjZhV8M',
  styles: 'https://youtu.be/aVEI8h4xntM',
  photos: 'https://youtu.be/YrFswQ4MNdg',
  clients: 'https://youtu.be/S5YZPCtakBQ',
  settings: 'https://youtu.be/ytfpvh8y_Wk',
  notifications: 'https://youtu.be/ctOB_gbRyf4',
};

// Inner pages use their section's video until they have their own.
// The first match wins, so put longer paths before shorter ones.
export const guideVideos = [
  {
    path: '/bookings/new',
    title: 'New appointment',
    video: VIDEOS.appointments,
  },
  {
    path: '/bookings/*/edit',
    title: 'Edit an appointment',
    video: VIDEOS.appointments,
  },
  {
    path: '/bookings/*',
    title: 'Appointment details',
    video: VIDEOS.appointments,
  },
  { path: '/bookings', title: 'Appointments', video: VIDEOS.appointments },
  {
    path: '/payment-reviews',
    title: 'Payment reviews',
    video: VIDEOS.appointments,
  },
  { path: '/balances', title: 'Balances outstanding', video: SAMPLE },
  { path: '/payments', title: 'Payments received', video: SAMPLE },
  { path: '/calendar', title: 'Calendar', video: VIDEOS.calendar },
  { path: '/styles/*', title: 'Edit a style', video: VIDEOS.styles },
  { path: '/styles', title: 'Styles & prices', video: VIDEOS.styles },
  { path: '/addons', title: 'Extras', video: VIDEOS.styles },
  { path: '/gallery', title: 'Photos & Our Work', video: VIDEOS.photos },
  { path: '/clients/*', title: 'Client details', video: VIDEOS.clients },
  { path: '/clients', title: 'Clients', video: VIDEOS.clients },
  { path: '/availability', title: 'Opening hours', video: VIDEOS.settings },
  { path: '/time-off', title: 'Time off', video: VIDEOS.settings },
  { path: '/email-templates', title: 'Email wording', video: VIDEOS.settings },
  { path: '/settings/*', title: 'Settings', video: VIDEOS.settings },
  { path: '/seo', title: 'Search & AI', video: VIDEOS.settings },
  {
    path: '/settings?tab=security',
    title: 'Sign-in & security',
    video: VIDEOS.settings,
  },
  { path: '/settings', title: 'Studio details', video: VIDEOS.settings },
  {
    path: '/notifications',
    title: 'Notifications',
    video: VIDEOS.notifications,
  },
  { path: '/', title: 'Overview', video: VIDEOS.overview },
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
