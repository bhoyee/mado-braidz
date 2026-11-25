// Titles, descriptions and structured data for public pages. Everything comes
// from published content; never add ratings or claims that are not on the page.
export const seoPages = {
  '/': {
    name: 'Home',
    title: 'African hair braiding in Lanham, MD',
    description:
      'Knotless braids, twists, locs and cornrows in Lanham, Maryland. See styles and clear prices, then book your chair online.',
  },
  '/styles': {
    name: 'Styles & prices',
    title: 'Braiding styles & prices in Lanham, MD',
    description:
      'Compare knotless braids, twists, locs and cornrows by size and length, with clear prices. Then book your chair in Lanham, Maryland.',
  },
  '/our-work': {
    name: 'Our Work',
    title: 'Braids, twists & locs: our work',
    description:
      'See real braids, twists and locs finished at our Lanham, Maryland studio.',
  },
  '/about': {
    name: 'Our Story',
    title: 'Meet Mado',
    description: 'Meet Mado and the braiding studio in Lanham, Maryland.',
  },
  '/contact': {
    name: 'Visit Us',
    title: 'Visit our Lanham, MD braiding studio',
    description:
      'Find the studio in Lanham, Maryland: address, opening hours, phone and directions.',
  },
  '/book': {
    name: 'Book',
    title: 'Book your braiding appointment',
    description:
      'Choose your braiding style, pick a date and time, and book your chair in Lanham, Maryland.',
  },
  '/policies': {
    name: 'Policies',
    title: 'Appointment policies',
    description:
      'Deposits, rescheduling, cancellations and how to prepare for your braiding appointment in Lanham, Maryland.',
  },
};
const otherDescriptions = {
  '/pay': 'Find your appointment and make a payment to the studio.',
  '/privacy': 'How the studio handles your personal information.',
  '/terms': 'Terms for using this website and booking with the studio.',
};
const days = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const dollars = (cents) => `$${(cents / 100).toFixed(cents % 100 ? 2 : 0)}`;
const price = (cents) => (cents / 100).toFixed(2);
const oneLine = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const prices = (style) =>
  (style.variants || []).map((v) => v.priceCents).filter((n) => n > 0);

function service(style, base) {
  const list = prices(style);
  return {
    '@type': 'Service',
    '@id': `${base}/styles/${style.slug}#service`,
    name: style.name,
    serviceType: 'Hair braiding',
    url: `${base}/styles/${style.slug}`,
    ...(style.shortDesc ? { description: oneLine(style.shortDesc) } : {}),
    provider: { '@id': `${base}/#salon` },
    ...(list.length
      ? {
          offers: {
            '@type': 'AggregateOffer',
            priceCurrency: 'USD',
            lowPrice: price(Math.min(...list)),
            highPrice: price(Math.max(...list)),
            offerCount: list.length,
            url: `${base}/book?style=${style.slug}`,
          },
        }
      : {}),
  };
}

function salon(data, social, base, full) {
  const { business, hours } = data;
  const all = data.styles.flatMap(prices);
  return {
    '@type': 'HairSalon',
    '@id': `${base}/#salon`,
    name: business.name,
    url: `${base}/`,
    telephone: business.phone,
    image: `${base}/img/share-card.jpg`,
    logo: `${base}/img/logo.png`,
    address: {
      '@type': 'PostalAddress',
      streetAddress: business.street,
      addressLocality: business.city,
      addressRegion: business.region,
      postalCode: business.postalCode,
      addressCountry: 'US',
    },
    ...(all.length
      ? {
          priceRange: `${dollars(Math.min(...all))}-${dollars(Math.max(...all))}`,
        }
      : {}),
    openingHoursSpecification: days
      .filter((day) => hours?.weekly?.[day] && !hours.weekly[day].closed)
      .map((day) => ({
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: day[0].toUpperCase() + day.slice(1),
        opens: hours.weekly[day].open,
        closes: hours.weekly[day].close,
      })),
    ...(hours?.specialDays?.length
      ? {
          specialOpeningHoursSpecification: hours.specialDays.map((day) => ({
            '@type': 'OpeningHoursSpecification',
            validFrom: day.date,
            validThrough: day.date,
            opens: day.closed ? '00:00' : day.open,
            closes: day.closed ? '00:00' : day.close,
          })),
        }
      : {}),
    // A search-results link is not a business profile.
    sameAs: Object.values(social || {}).filter(
      (url) =>
        typeof url === 'string' &&
        url.startsWith('https://') &&
        !url.includes('/search/'),
    ),
    ...(full
      ? {
          hasOfferCatalog: {
            '@type': 'OfferCatalog',
            name: 'Braiding styles',
            itemListElement: data.styles.map((style) => ({
              '@type': 'Offer',
              ...(style.from
                ? {
                    priceSpecification: {
                      '@type': 'PriceSpecification',
                      minPrice: price(style.from),
                      priceCurrency: 'USD',
                    },
                  }
                : {}),
              itemOffered: {
                '@type': 'Service',
                name: style.name,
                url: `${base}/styles/${style.slug}`,
              },
            })),
          },
        }
      : {}),
  };
}
const faqPage = (faq, url) => ({
  '@type': 'FAQPage',
  '@id': `${url}#faq`,
  mainEntity: faq.map((item) => ({
    '@type': 'Question',
    name: oneLine(item.question),
    acceptedAnswer: { '@type': 'Answer', text: oneLine(item.answer) },
  })),
});
const breadcrumbs = (style, base) => ({
  '@type': 'BreadcrumbList',
  itemListElement: [
    ['Home', '/'],
    ['Styles', '/styles'],
    [style.name, `/styles/${style.slug}`],
  ].map(([name, path], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    item: base + path,
  })),
});

// Returns null for private or unknown pages, which then stay out of search and
// never publish their address in sharing tags.
export function pageSeo(path, data, root, { areas = {}, social } = {}) {
  const clean = path.length > 1 ? path.replace(/\/+$/, '') : path;
  const base = root.replace(/\/$/, '');
  const part = (prefix) =>
    clean.startsWith(prefix) ? clean.slice(prefix.length) : null;
  const saved = data.settings?.search || {};
  const page = Object.hasOwn(seoPages, clean) ? seoPages[clean] : null;
  const own = (page && saved.pages?.[clean]) || {};
  const name = data.business.name;
  let title = page ? own.title || `${page.title} | ${name}` : null;
  let description = page
    ? own.description || page.description
    : otherDescriptions[clean];
  const slug = part('/styles/');
  const style = slug && data.styles.find((item) => item.slug === slug);
  if (style) {
    const from = style.from ? ` from ${dollars(style.from)}` : '';
    title =
      style.seoTitle ||
      `${style.name} in Lanham, MD${style.from ? ` | From ${dollars(style.from)}` : ''} | ${name}`;
    description =
      style.seoDescription ||
      `${style.name}${from} in Lanham, Maryland. See options and book your chair online.`;
  }
  const town = part('/areas/');
  if (town && Object.hasOwn(areas, town))
    description = `Braids, twists and locs near ${areas[town].name}, at our studio in Lanham, Maryland.`;
  if (!description) return null;
  const faq = data.pages?.faq || [];
  const graph = [];
  if (clean === '/' || clean === '/contact' || style)
    graph.push(salon(data, social, base, clean === '/'));
  if (style) graph.push(service(style, base), breadcrumbs(style, base));
  if ((clean === '/' || style) && faq.length)
    graph.push(faqPage(faq, base + clean));
  return {
    title,
    description,
    canonical: base + clean,
    image: `${base}/img/share-card.jpg`,
    imageAlt: `${name} logo beside finished braids`,
    verification: clean === '/' ? saved.verification || [] : [],
    // Escaped so database text cannot close the script element.
    graph: graph.length
      ? JSON.stringify({
          '@context': 'https://schema.org',
          '@graph': graph,
        }).replaceAll('<', '\\u003c')
      : null,
  };
}

// Plain-text guide for AI assistants: the same facts the pages show.
export function siteGuide(data, root) {
  const base = root.replace(/\/$/, '');
  const { business: b, hours, policy, booking } = data;
  const time = (value) => {
    const [h, m] = value.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const open = days
    .filter((day) => hours?.weekly?.[day])
    .map((day) => {
      const d = hours.weekly[day];
      return `- ${day[0].toUpperCase() + day.slice(1)}: ${d.closed ? 'Closed' : `${time(d.open)} to ${time(d.close)}`}`;
    });
  return [
    `# ${oneLine(b.name)}`,
    '',
    `> ${seoPages['/'].description}`,
    '',
    `- Address: ${[b.street, b.city, b.region].map(oneLine).join(', ')} ${oneLine(b.postalCode)}`,
    `- Phone: ${oneLine(data.phoneDisplay || b.phone)}`,
    `- Book online: ${base}/book`,
    `- Deposit: ${dollars(booking.depositCents)}, applied to the total${policy?.depositRefundable === false ? ' (non-refundable if you cancel)' : ''}`,
    '',
    '## Opening hours (Eastern time)',
    ...open,
    '',
    '## Styles and starting prices (USD)',
    ...data.styles.map(
      (s) =>
        `- [${oneLine(s.name)}](${base}/styles/${s.slug}): ${s.from ? `from ${dollars(s.from)}` : 'price on consultation'}`,
    ),
    '',
    '## Common questions',
    ...(data.pages?.faq || []).map(
      (f) => `- ${oneLine(f.question)} ${oneLine(f.answer)}`,
    ),
    '',
    '## Pages',
    ...Object.entries(seoPages).map(
      ([path, p]) => `- [${p.name}](${base}${path})`,
    ),
    `- [Privacy](${base}/privacy)`,
    `- [Terms](${base}/terms)`,
    '',
  ].join('\n');
}

const reserved =
  /^(robots|googlebot|bingbot|viewport|referrer|description|theme-color|color-scheme|csrf-token|twitter:.*|og:.*)$/i;
// Accepts a full verification tag, or just the code for a known service. Only
// a name and a plain code are kept, so nothing pasted here can run as a script.
export function verificationTag(input, knownName) {
  const value = input.trim();
  if (!value) return null;
  const attribute = (key) =>
    value.match(new RegExp(`\\s${key}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
  const isTag = /^<meta\s[^<>]*>$/i.test(value);
  const name = isTag ? attribute('name') : knownName;
  const content = isTag ? attribute('content') : value;
  if (
    !name ||
    (knownName && name.toLowerCase() !== knownName.toLowerCase()) ||
    !/^[a-z0-9][a-z0-9._:-]{1,59}$/i.test(name) ||
    reserved.test(name) ||
    !/^[A-Za-z0-9_.=+/-]{4,200}$/.test(content || '')
  )
    throw new Error('Paste the verification tag exactly as the tool gives it.');
  return { name: name.toLowerCase(), content };
}
