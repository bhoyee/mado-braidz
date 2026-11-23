const descriptions = {
  '/styles':
    'Compare knotless braids, twists, locs and cornrows by size and length, with clear prices. Then book your chair in Lanham, Maryland.',
  '/our-work':
    'See real braids, twists and locs finished at our Lanham, Maryland studio.',
  '/about': 'Meet Mado and the braiding studio in Lanham, Maryland.',
  '/contact':
    'Find the studio in Lanham, Maryland: address, opening hours, phone and directions.',
  '/book':
    'Choose your braiding style, pick a date and time, and book your chair in Lanham, Maryland.',
  '/pay': 'Find your appointment and make a payment to the studio.',
  '/policies': 'Deposits, rescheduling and what to know before your visit.',
  '/privacy': 'How the studio handles your personal information.',
  '/terms': 'Terms for using this website and booking with the studio.',
};
export const homeDescription =
  'Knotless braids, twists, locs and cornrows in Lanham, Maryland. See styles and clear prices, then book your chair online.';
const days = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

function salon(business, hours, social, root) {
  return {
    '@context': 'https://schema.org',
    '@type': 'HairSalon',
    '@id': `${root}/#salon`,
    name: business.name,
    url: `${root}/`,
    telephone: business.phone,
    image: `${root}/img/share-card.jpg`,
    logo: `${root}/img/logo.png`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: business.street,
      addressLocality: business.city,
      addressRegion: business.region,
      postalCode: business.postalCode,
      addressCountry: 'US',
    },
    openingHoursSpecification: days
      .filter((day) => hours?.weekly?.[day] && !hours.weekly[day].closed)
      .map((day) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: day[0].toUpperCase() + day.slice(1),
        opens: hours.weekly[day].open,
        closes: hours.weekly[day].close,
      })),
    // A search-results link is not a business profile.
    sameAs: Object.values(social || {}).filter(
      (url) =>
        typeof url === 'string' &&
        url.startsWith('https://') &&
        !url.includes('/search/'),
    ),
  };
}

// Returns null for private or unknown pages, which then stay out of search and
// never publish their address in sharing tags.
export function pageSeo(path, data, root, { areas = {}, social } = {}) {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const base = root.replace(/\/$/, '');
  const part = (prefix) =>
    clean.startsWith(prefix) ? clean.slice(prefix.length) : null;
  let description = clean === '/' ? homeDescription : descriptions[clean];
  const slug = part('/styles/');
  const style = slug && data.styles.find((item) => item.slug === slug);
  if (style) {
    const from = style.from
      ? ` from $${(style.from / 100).toFixed(style.from % 100 ? 2 : 0)}`
      : '';
    description =
      style.seoDescription ||
      `${style.name}${from} in Lanham, Maryland. See options and book your chair online.`;
  }
  const town = part('/areas/');
  if (town && Object.hasOwn(areas, town))
    description = `Braids, twists and locs near ${areas[town].name}, at our studio in Lanham, Maryland.`;
  if (!description) return null;
  return {
    description,
    canonical: base + clean,
    image: `${base}/img/share-card.jpg`,
    imageAlt: `${data.business.name} logo beside finished braids`,
    // Escaped so database text cannot close the script element.
    salon:
      clean === '/' || clean === '/contact'
        ? JSON.stringify(
            salon(data.business, data.hours, social, base),
          ).replaceAll('<', '\\u003c')
        : null,
  };
}
