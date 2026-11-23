import { publicSettings } from '../../db/public-defaults.js';
import { studioVideos } from '../../services/studioVideos.js';
import { Router } from 'express';
import { z } from 'zod';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { DateTime } from 'luxon';
import { generateToken } from '../../middleware/csrf.js';
export const areas = {
  bowie: {
    name: 'Bowie',
    copy: 'Planning your next style from Bowie? Our Lanham studio welcomes you for knotless braids, boho finishes and twists. Call ahead to talk through length and hair preparation.',
  },
  greenbelt: {
    name: 'Greenbelt',
    copy: 'From Greenbelt to your chair in Lanham: explore medium knotless braids, a boho bob or a consultation for locs. Bring your inspiration and confirm the right hair before your visit.',
  },
  largo: {
    name: 'Largo',
    copy: 'A fresh look starts with a little planning. Browse the menu from Largo, then call our Lanham studio to discuss your chosen size, length and appointment.',
  },
  hyattsville: {
    name: 'Hyattsville',
    copy: 'Looking for braiding near Hyattsville? Compare our knotless and twist lengths online, then arrange time at the Lanham studio with Mado.',
  },
  'new-carrollton': {
    name: 'New Carrollton',
    copy: 'Make time for your next braiding appointment near New Carrollton. Our studio is in Lanham, with prices listed by size and length so you can plan ahead.',
  },
  'college-park': {
    name: 'College Park',
    copy: 'Explore a shorter boho bob or waist-length knotless braids from College Park. Speak with Mado about the look you want before heading to the Lanham studio.',
  },
  'upper-marlboro': {
    name: 'Upper Marlboro',
    copy: 'For clients coming from Upper Marlboro, start with the price menu and hair preparation guide. Call to confirm your appointment before travelling to Lanham.',
  },
  landover: {
    name: 'Landover',
    copy: 'Your next style, a little closer to home. Clients from Landover can explore Fulani braids, twists and locs, then call the Lanham studio for a consultation.',
  },
};
// Display order for lengths in price grids (null = no length, e.g. Boho Bob).
const LENGTH_ORDER = [
  'shoulder',
  'mid_back',
  'waist',
  'top_butt',
  'butt',
  'under_butt',
  null,
];
export const label = (value) =>
  ({
    semi_medium: 'Semi-medium',
    mid_back: 'Mid back',
    top_butt: 'Top butt',
    under_butt: 'Under butt',
    butt: 'Butt length',
    shoulder: 'Shoulder length',
    waist: 'Waist length',
    medium: 'Medium',
    small: 'Small',
  })[value] ||
  value ||
  'Standard';
export const money = (cents) =>
  new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
export function safePhoto(photo) {
  if (
    !photo ||
    !photo.alt ||
    typeof photo.path !== 'string' ||
    photo.path?.split('/').some((part) => part === '..' || part === '.') ||
    !/^\/(?:img|media)\/[a-zA-Z0-9/_().-]+\.(?:avif|webp|jpg|jpeg|png)$/i.test(
      photo.path,
    )
  )
    return null;
  const variants =
    typeof photo.variants === 'string'
      ? JSON.parse(photo.variants)
      : photo.variants;
  const sizes = (variants?.sizes || []).filter(
    (item) =>
      typeof item.path === 'string' &&
      /^\/(?:img\/(?:styles|gallery)|media\/catalog)\/[a-z0-9-]+\.webp$/.test(
        item.path,
      ) &&
      Number.isInteger(item.width),
  );
  const uniqueSizes = [
    ...new Map(sizes.map((item) => [item.width, item])).values(),
  ];
  return {
    ...photo,
    generated: variants?.origin === 'generated',
    origin: variants?.origin || 'supplied',
    variants,
    srcset: uniqueSizes.map((item) => `${item.path} ${item.width}w`).join(', '),
    avifSrcset: uniqueSizes
      .filter(
        (item) =>
          typeof item.avif === 'string' &&
          /^\/(?:img\/(?:styles|gallery)|media\/catalog)\/[a-z0-9-]+\.avif$/.test(
            item.avif,
          ),
      )
      .map((item) => `${item.avif} ${item.width}w`)
      .join(', '),
    avifPath: sizes.at(-1)?.avif,
  };
}
// Social profiles shown in the footer: only https links for known networks,
// in a fixed order. Empty or missing entries are simply not shown.
const SOCIAL_NETWORKS = [
  ['instagram', 'Instagram'],
  ['tiktok', 'TikTok'],
  ['facebook', 'Facebook'],
  ['google', 'Google reviews'],
];
export function socialLinks(social = {}) {
  return SOCIAL_NETWORKS.flatMap(([key, name]) => {
    const url = typeof social?.[key] === 'string' ? social[key].trim() : '';
    return /^https:\/\/[^\s"'<>]+$/.test(url) ? [{ key, name, url }] : [];
  });
}
// Style search: lower-case words only, so "Mid-back" and "mid back" match.
export const searchWords = (text) =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
// Everything a visitor might type about a style: name, category, sizes, lengths.
export const styleSearchText = (style) =>
  searchWords(
    [
      style.name,
      style.category,
      ...style.groups.flatMap((g) => [
        g.name,
        ...g.variants.map((v) => v.lengthLabel),
      ]),
      style.groups.length ? '' : 'consultation',
    ].join(' '),
  );
// Just the style's own words (name, category); sizes and lengths are matched
// per option tile in the browser, so "waist" shows only waist-length options.
export const styleCoreSearchText = (style) =>
  searchWords(
    [
      style.name,
      style.category,
      style.groups.length ? '' : 'consultation',
    ].join(' '),
  );
export const matchesSearch = (text, query) =>
  searchWords(query)
    .split(' ')
    .filter(Boolean)
    .every((word) => text.includes(word));
// Our Work: short labels for extra gallery photos (their alt text is a full
// description for screen readers, too long to show on the picture).
const GALLERY_LABELS = {
  'sew-in': 'Sew-in',
  'spring-twist': 'Spring twists',
  'tribal-crochet': 'Tribal crochet',
};
export const galleryLabel = (item) => {
  const key = String(item.path || '')
    .split('/')
    .pop()
    .replace(/-\d+\.(?:webp|avif|jpe?g|png)$/i, '')
    .replace(/-(?:detail|finish)$/, '');
  return (
    GALLERY_LABELS[key] ||
    key.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) ||
    'Our work'
  );
};
// Photos and films mixed into one portfolio: a film, two photos, a film...
export function workItems(suppliedStyles, gallery, videos = studioVideos()) {
  const photos = [
    ...suppliedStyles
      .filter((style) => style.photo?.variants?.showInWork !== false)
      .map((style) => ({
        type: 'photo',
        photo: style.photo,
        label: style.name,
        href: `/styles/${style.slug}`,
      })),
    ...gallery.map((item) => ({
      type: 'photo',
      photo: item,
      label:
        item.styleName ||
        (item.path.startsWith('/media/catalog/')
          ? item.alt
          : galleryLabel(item)),
    })),
  ];
  const seenPhotos = new Set();
  const uniquePhotos = photos.filter((item) => {
    const path = item.photo.path;
    if (seenPhotos.has(path)) return false;
    seenPhotos.add(path);
    return true;
  });
  photos.splice(0, photos.length, ...uniquePhotos);
  const films = videos
    .filter((v) => v.enabled && v.showInWork)
    .map((v) => ({ type: 'film', ...v, name: v.id }));
  const items = [];
  while (photos.length || films.length) {
    if (films.length) items.push(films.shift());
    items.push(...photos.splice(0, films.length ? 2 : photos.length));
  }
  return items;
}
export function decorateCatalog(data) {
  const styles = data.styles.map((style) => {
    const allPhotos = (style.photos || []).map(safePhoto).filter(Boolean);
    const prices = style.variants.map((v) => v.priceCents);
    const from = prices.length ? Math.min(...prices) : style.fromPriceCents;
    const groups = [...new Set(style.variants.map((v) => v.size))].map(
      (size) => ({
        key: size || 'standard',
        name: label(size),
        from: Math.min(
          ...style.variants
            .filter((v) => v.size === size)
            .map((v) => v.priceCents),
        ),
        photo: allPhotos.find((photo) => photo.variants?.size === size),
        variants: style.variants
          .filter((v) => v.size === size)
          .map((v) => ({
            ...v,
            sizeLabel: label(v.size),
            lengthLabel: label(v.length),
          })),
      }),
    );
    return {
      ...style,
      categoryName:
        data.categories.find((category) => category.slug === style.category)
          ?.name || style.category,
      flatPrice:
        style.variants.length === 1 &&
        !style.variants[0].size &&
        !style.variants[0].length,
      from,
      // Price grid for the home menu: lengths down the side, sizes across.
      matrix: groups.length
        ? {
            sizes: groups.map((group) => group.name),
            rows: LENGTH_ORDER.filter((length) =>
              style.variants.some((v) => (v.length ?? null) === length),
            ).map((length) => ({
              label: length ? label(length) : 'All lengths',
              cells: groups.map(
                (group) =>
                  group.variants.find((v) => (v.length ?? null) === length)
                    ?.priceCents ?? null,
              ),
            })),
          }
        : null,
      // True when variants differ only by size (e.g. Boho Bob), not length.
      lengthless:
        style.variants.length > 0 && style.variants.every((v) => !v.length),
      groups,
      photos: allPhotos.filter((photo) => !photo.variants?.size),
      photo: allPhotos.find((photo) => !photo.variants?.size) || allPhotos[0],
      longHtml: style.longDesc
        ? sanitizeHtml(marked.parse(style.longDesc), {
            allowedTags: [
              'p',
              'strong',
              'em',
              'ul',
              'ol',
              'li',
              'h2',
              'h3',
              'blockquote',
            ],
            allowedAttributes: {},
          })
        : null,
    };
  });
  const b = data.settings.business;
  const pages = { ...(data.settings.seo?.pages || {}) };
  let openingHours = data.settings.hours;
  if (openingHours?.customHours) {
    const today = DateTime.now().setZone('America/New_York');
    const current = openingHours.weekly[today.toFormat('cccc').toLowerCase()];
    const format = (value) =>
      DateTime.fromISO(today.toISODate() + 'T' + value, {
        zone: 'America/New_York',
      }).toFormat('h:mm a');
    openingHours = {
      ...openingHours,
      daysLabel: today.toFormat('cccc'),
      timeLabel: current.closed
        ? 'Closed'
        : format(current.open) + '–' + format(current.close),
      sundayLabel: 'Eastern time',
    };
  }
  if (pages.faq)
    pages.faq = pages.faq.map((item) => {
      const initial = publicSettings.seo.pages.faq.find(
        (row) => row.question === item.question,
      );
      if (!initial || initial.answer !== item.answer) return item;
      const booking = data.settings.booking,
        policy = data.settings.policy;
      if (item.question === 'How does the deposit work?')
        return {
          ...item,
          answer: `Your ${money(booking.depositCents)} deposit reserves your chair and is applied toward your total. ${policy.depositRefundable ? 'Refunds follow the studio policy.' : 'The deposit is non-refundable.'} Pay the remaining balance online or at your appointment.`,
        };
      if (item.question === 'Can I reschedule?')
        return {
          ...item,
          answer: `The policy allows ${policy.freeReschedules} free reschedule(s) with at least ${policy.rescheduleHours} hours of notice. Call the studio to arrange a change.`,
        };
      if (item.question === 'Do I need to bring my own hair?') {
        const upgrade = data.addons.find(
          (a) => a.slug === 'human-hair-upgrade',
        );
        return {
          ...item,
          answer:
            'Hair with 50% human hair is included.' +
            (upgrade
              ? ' Choose the 100% human hair upgrade for ' +
                money(upgrade.priceCents) +
                '.'
              : ''),
        };
      }
      return item;
    });
  // Upgrade only the original scaffold copy; preserve owner-written content.
  if (
    !pages.home ||
    [
      'Braids done slowly,',
      'A fresh look.',
      'The art of beautiful braids.',
      'Knotless braids, twists & locs in Lanham, MD.',
    ].includes(pages.home.heading)
  )
    pages.home = publicSettings.seo.pages.home;
  return {
    ...data,
    studioClips: Object.fromEntries(
      studioVideos(data.settings).map((v) => [v.id, v]),
    ),
    styles,
    featuredStyles: styles.filter(
      (style) => style.featured && style.active !== false,
    ),
    mensStyles: styles.filter((style) => style.category === 'mens'),
    heroStyle:
      styles.find((style) => style.slug === 'knotless-braids') || styles[0],
    consultStyles: styles.filter((style) => !style.groups.length),
    suppliedStyles: styles.filter(
      (style) => style.photo && !style.photo.generated,
    ),
    business: b,
    social: socialLinks(b.social ?? publicSettings.social),
    humanHairUpgrade: data.addons.find(
      (addon) => addon.slug === 'human-hair-upgrade',
    ),
    booking: data.settings.booking,
    pages,
    hours: openingHours,
    policy: data.settings.policy,
    phoneDisplay: b.phone === '+14437434979' ? '(443) 743-4979' : b.phone,
    directions:
      'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${b.street}, ${b.city}, ${b.region} ${b.postalCode}`),
    mapEmbed:
      'https://www.google.com/maps?q=' +
      encodeURIComponent(
        `${b.street}, ${b.city}, ${b.region} ${b.postalCode}`,
      ) +
      '&output=embed',
    gallery: data.gallery
      .map((photo) => ({
        ...photo,
        styleName: styles.find((style) => style.id === photo.styleId)?.name,
      }))
      .map(safePhoto)
      .filter(Boolean),
    year: new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      timeZone: b.timezone,
    }).format(new Date()),
  };
}
export function publicRouter(catalog, paymentRoutes, contactRoutes) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      Object.assign(res.locals, decorateCatalog(await catalog.load()), {
        currentPath: req.path,
      });
      const redirect = (res.locals.redirects || []).find(
        (r) => r.source === req.path,
      );
      if (redirect && ['GET', 'HEAD'].includes(req.method))
        return res.redirect(301, redirect.target);
      next();
    } catch (error) {
      next(error);
    }
  });
  const render =
    (page, title, extra = {}) =>
    (req, res) =>
      res.render(`pages/${page}`, {
        title: `${title} | ${res.locals.business.name}`,
        ...extra,
      });
  if (paymentRoutes) router.use(paymentRoutes);
  router.get('/sitemap.xml', (_req, res) => {
    const escape = (value) =>
      String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
    const root = res.locals.business.url.replace(/\/$/, '');
    const urls = [
      '/',
      '/styles',
      '/our-work',
      '/about',
      '/contact',
      '/policies',
      '/privacy',
      '/terms',
    ]
      .map((path) => ({ path }))
      .concat(
        res.locals.styles.map((style) => ({
          path: '/styles/' + style.slug,
          updatedAt: style.updatedAt,
        })),
      );
    res
      .type('application/xml')
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
          urls
            .map(
              (row) =>
                '<url><loc>' +
                escape(root + row.path) +
                '</loc>' +
                (row.updatedAt
                  ? '<lastmod>' +
                    new Date(row.updatedAt).toISOString() +
                    '</lastmod>'
                  : '') +
                '</url>',
            )
            .join('') +
          '</urlset>',
      );
  });
  if (contactRoutes) router.use(contactRoutes);
  router.get('/', render('home', 'African hair braiding in Lanham, MD'));
  router.get('/styles', (req, res) => {
    const category = z
      .string()
      .max(40)
      .optional()
      .safeParse(req.query.category);
    if (
      !category.success ||
      (category.data &&
        !res.locals.categories.some((c) => c.slug === category.data))
    )
      return res.status(400).render('pages/message', {
        title: 'Choose a category',
        heading: 'Let’s find your style.',
        message: 'Choose one of the categories in our style collection.',
        backUrl: '/styles',
        backLabel: 'See all styles',
      });
    // Free-text search (also works without JavaScript); anything odd is ignored.
    const q = z.string().max(60).optional().safeParse(req.query.q);
    const query = q.success ? (q.data ?? '').trim() : '';
    // Every style in the category is sent; non-matches are hidden, so the live
    // search can bring them back when the query changes.
    const filtered = res.locals.styles
      .filter((s) => !category.data || s.category === category.data)
      .map((s) => {
        const searchText = styleSearchText(s);
        return {
          ...s,
          searchText,
          searchCore: styleCoreSearchText(s),
          searchHidden: Boolean(query) && !matchesSearch(searchText, query),
        };
      });
    res.render('pages/styles', {
      title: `Braiding styles | ${res.locals.business.name}`,
      selected: category.data,
      query,
      filtered,
      matchCount: filtered.filter((s) => !s.searchHidden).length,
    });
  });
  router.get('/styles/:slug', (req, res, next) => {
    const style = res.locals.styles.find((s) => s.slug === req.params.slug);
    if (!style) return next();
    const result = z.string().max(24).optional().safeParse(req.query.size);
    const selectedSize = result.success
      ? result.data || (style.groups.length === 1 ? style.groups[0].key : null)
      : null;
    const selectedGroup = style.groups.find(
      (group) => group.key === selectedSize,
    );
    const invalidSize =
      !result.success || (Boolean(result.data) && !selectedGroup);
    res.status(invalidSize ? 400 : 200).render('pages/style', {
      selectedSize: invalidSize ? null : selectedSize,
      selectedGroup: invalidSize ? null : selectedGroup,
      invalidSize,
      title:
        style.seoTitle ||
        `${style.name} in Lanham, MD | ${res.locals.business.name}`,
      description: style.seoDescription,
      style,
    });
  });
  router.get('/prices', (_req, res) => res.redirect(301, '/styles'));
  router.get('/gallery', (_req, res) => res.redirect(301, '/our-work'));
  router.get('/our-work', (req, res) =>
    res.render('pages/gallery', {
      title: `Our Work | ${res.locals.business.name}`,
      items: workItems(
        res.locals.suppliedStyles,
        res.locals.gallery,
        Object.values(res.locals.studioClips),
      ),
    }),
  );
  router.get('/about', render('about', 'Meet Mado'));
  router.get('/book', (req, res) => {
    res.set('Cache-Control', 'no-store').render('pages/book', {
      title: `Book your chair | ${res.locals.business.name}`,
      csrfToken: generateToken(req),
    });
  });
  router.get(
    '/book/success',
    render('message', 'Your appointment', {
      heading: 'Let’s check your appointment.',
      message:
        'Online payment confirmation is not available yet. If you have arranged an appointment, call the studio to confirm its details.',
      call: true,
    }),
  );
  router.get('/booking/:token', (_req, res) =>
    res.status(404).render('pages/message', {
      title: 'Manage your appointment',
      heading: 'Need to change your appointment?',
      message:
        'Online appointment management is not available yet. Please call the studio for help. This page does not confirm an appointment.',
      call: true,
    }),
  );
  for (const page of ['policies', 'privacy', 'terms'])
    router.get(
      `/${page}`,
      render('legal', page[0].toUpperCase() + page.slice(1), {
        legalPage: page,
      }),
    );
  router.get('/areas/:town', (req, res, next) => {
    const area = Object.hasOwn(areas, req.params.town)
      ? areas[req.params.town]
      : null;
    if (!area) return next();
    res.render('pages/area', {
      title: `Hair braiding near ${area.name} | ${res.locals.business.name}`,
      area,
    });
  });
  return router;
}
