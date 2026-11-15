import { Router } from 'express';
import { z } from 'zod';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
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
export const label = (value) =>
  ({
    semi_medium: 'Semi-medium',
    mid_back: 'Mid back',
    top_butt: 'Top butt',
    under_butt: 'Under butt',
    butt: 'Butt length',
    shoulder: 'Shoulder',
    waist: 'Waist',
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
  return photo;
}
export function decorateCatalog(data) {
  const styles = data.styles.map((style) => {
    const prices = style.variants.map((v) => v.priceCents);
    const from = prices.length ? Math.min(...prices) : style.fromPriceCents;
    const groups = [...new Set(style.variants.map((v) => v.size))].map(
      (size) => ({
        name: label(size),
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
      from,
      groups,
      photos: (style.photos || []).map(safePhoto).filter(Boolean),
      photo: (style.photos || []).map(safePhoto).find(Boolean),
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
  return {
    ...data,
    styles,
    business: b,
    booking: data.settings.booking,
    pages: data.settings.seo?.pages || {},
    hours: data.settings.hours,
    policy: data.settings.policy,
    phoneDisplay: b.phone === '+14437434979' ? '(443) 743-4979' : b.phone,
    directions:
      'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${b.street}, ${b.city}, ${b.region} ${b.postalCode}`),
    mapEmbed:
      'https://maps.google.com/maps?q=' +
      encodeURIComponent(
        `${b.street}, ${b.city}, ${b.region} ${b.postalCode}`,
      ) +
      '&output=embed',
    gallery: data.gallery.map(safePhoto).filter(Boolean),
    year: new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      timeZone: b.timezone,
    }).format(new Date()),
  };
}
export function publicRouter(catalog) {
  const router = Router();
  router.use(async (req, res, next) => {
    try {
      Object.assign(res.locals, decorateCatalog(await catalog.load()), {
        currentPath: req.path,
      });
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
    res.render('pages/styles', {
      title: `Braiding styles | ${res.locals.business.name}`,
      selected: category.data,
      filtered: res.locals.styles.filter(
        (s) => !category.data || s.category === category.data,
      ),
    });
  });
  router.get('/styles/:slug', (req, res, next) => {
    const style = res.locals.styles.find((s) => s.slug === req.params.slug);
    if (!style) return next();
    res.render('pages/style', {
      title:
        style.seoTitle ||
        `${style.name} in Lanham, MD | ${res.locals.business.name}`,
      description: style.seoDescription,
      style,
    });
  });
  router.get('/prices', render('prices', 'The price menu'));
  router.get('/gallery', render('gallery', 'Fresh from the chair'));
  router.get('/about', render('about', 'Meet Mado'));
  router.get('/contact', (req, res) =>
    res.render('pages/contact', {
      title: `Visit the studio | ${res.locals.business.name}`,
      csrfToken: generateToken(req),
    }),
  );
  router.post('/contact', (req, res) =>
    res.status(503).render('pages/contact', {
      title: 'Contact the studio',
      csrfToken: generateToken(req),
      contactUnavailable: true,
    }),
  );
  router.get(
    '/book',
    render('message', 'Book your chair', {
      heading: 'Your chair is waiting.',
      message:
        'Online booking is coming soon. Call Mado to choose your style and arrange your appointment. No payment is taken on this website yet.',
      call: true,
    }),
  );
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
