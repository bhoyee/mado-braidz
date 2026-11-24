import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  entityId,
  durationFromHours,
  checked,
  dollars,
} from '../../services/managementValidation.js';
import { prepareCatalogImage } from '../../services/catalogImages.js';
import { prepareCatalogVideo } from '../../services/catalogVideos.js';
import { publicSettings } from '../../db/public-defaults.js';
import { ManagementError } from '../../services/managementErrors.js';
import { seoPages, verificationTag } from '../../services/pageSeo.js';
import { photoPlacement } from '../../services/photoPlacement.js';
import {
  durationChoices,
  durationLabel,
  lengthNames,
  priceGrid,
  sizeNames,
  styleSummary,
} from '../../services/styleSummary.js';

const optionalId = (v) => (v ? entityId.parse(v) : null);
const text = (max) => z.string().trim().max(max).default('');
const socials = z.union([
  z.literal(''),
  z.url().refine((v) => v.startsWith('https://'), 'Use an HTTPS link'),
]);
export function managementRouter(service, config) {
  const router = Router();
  const run = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res)).catch(next);
  const actor = (req, res) => ({ ...res.locals.admin, ip: req.ip });
  const finish = (req, res, url) =>
    req.accepts(['html', 'json']) === 'json'
      ? res.json({ url, message: 'Saved.' })
      : res.redirect(303, url);
  const render = async (req, res, page, extra = {}) => {
    const data = await service.all();
    if (page === 'gallery')
      data.stylesWithoutPhotos = data.styles.filter(
        (style) =>
          !data.media.some(
            (photo) => photo.kind === 'style' && photo.styleId === style.id,
          ),
      );
    data.settings.business.social ??= publicSettings.social;
    data.settings.emails ??= {
      reminderHours: 48,
      morningReminder: true,
      winback: true,
      adminAlertEmails: [],
    };
    res.render('admin/manage/' + page, { ...data, ...extra });
  };
  const idList = z.array(entityId).max(500);
  const flag = z.boolean().optional();
  router.get(
    '/styles',
    run(async (req, res) => {
      const data = await service.all();
      res.render('admin/manage/styles', {
        ...data,
        styles: data.styles.map((style) => styleSummary(style, data)),
        categories: data.categories.map((category) => ({
          ...category,
          count: data.styles.filter((style) => style.categoryId === category.id)
            .length,
        })),
      });
    }),
  );
  const styleForm = (variants, item) => ({
    grid: priceGrid(variants),
    sizeNames,
    lengthNames,
    // Show the sizes and lengths in use; a new style starts with one price.
    usedSizes: sizeNames
      .filter(({ value }) =>
        variants.length
          ? variants.some((v) => (v.size || '') === value)
          : value === '',
      )
      .map(({ value }) => value),
    usedLengths: lengthNames
      .filter(({ value }) =>
        variants.length
          ? variants.some((v) => (v.length || '') === value)
          : value === '',
      )
      .map(({ value }) => value),
    durations: durationChoices(
      item.durationMin,
      ...variants.map((v) => v.durationMin),
    ),
    ownTimes: variants.some((v) => v.durationMin || v.label),
  });
  router.get(
    '/styles/new',
    run((req, res) => {
      const item = { active: true, durationMin: 240 };
      return render(req, res, 'style', { item, ...styleForm([], item) });
    }),
  );
  router.get(
    '/styles/:id',
    run(async (req, res) => {
      const data = await service.all(),
        id = entityId.parse(req.params.id),
        item = data.styles.find((r) => r.id === id);
      if (!item)
        return res
          .status(404)
          .render('admin/error', { error: 'Style not found.' });
      const variants = data.variants.filter((r) => r.styleId === id);
      res.render('admin/manage/style', {
        ...data,
        item,
        ...styleForm(variants, item),
        photos: data.media.filter(
          (photo) => photo.styleId === id && photo.kind === 'style',
        ),
        lastEdit: await service.lastEdit(id),
        history: await service.priceHistory(id),
      });
    }),
  );
  // A new style can carry its first photo, so this form may be multipart.
  const styleUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 1,
      fields: 40,
      fieldSize: 32 * 1024,
    },
  }).single('photo');
  const priceRows = z
    .array(
      z.object({
        id: z.union([entityId, z.literal(''), z.null()]).optional(),
        size: z.string().max(20).nullish(),
        length: z.string().max(20).nullish(),
        label: z.string().max(255).nullish(),
        price: z.string().max(12),
        durationMin: z.union([z.string().max(4), z.number()]).nullish(),
        active: z.boolean(),
      }),
    )
    .max(60);
  router.post(
    '/styles/save',
    (req, res, next) =>
      styleUpload(req, res, (error) =>
        next(error ? new ManagementError('Choose a photo under 8 MB.') : null),
      ),
    run(async (req, res) => {
      const body = { ...req.body };
      if (body.prices) {
        try {
          body.prices = JSON.parse(body.prices);
        } catch {
          throw new ManagementError('Refresh the page and try again.');
        }
        body.prices = priceRows.parse(body.prices);
      } else delete body.prices;
      const existing = optionalId(body.id);
      const photo =
        !existing && req.file
          ? await prepareCatalogImage(req.file.buffer, config.UPLOAD_DIR)
          : null;
      let id;
      try {
        id = await service.saveStyle(
          existing,
          durationFromHours(body),
          actor(req, res),
        );
        if (photo)
          await service.saveMedia(
            null,
            {
              path: photo.path,
              width: photo.width,
              height: photo.height,
              variants: photo.variants,
              alt: text(500).parse(body.photoAlt) || body.name + ' hairstyle',
              kind: 'style',
              styleId: id,
              sort: 0,
            },
            actor(req, res),
          );
      } catch (error) {
        await photo?.cleanup();
        throw error;
      }
      finish(req, res, '/admin/styles/' + id);
    }),
  );
  router.post(
    '/styles/reorder',
    run(async (req, res) => {
      await service.reorderStyles(idList.parse(req.body.ids), actor(req, res));
      finish(req, res, '/admin/styles');
    }),
  );
  router.post(
    '/styles/categories',
    run(async (req, res) => {
      await service.saveCategory(
        optionalId(req.body.id),
        req.body.name,
        actor(req, res),
      );
      finish(req, res, '/admin/styles');
    }),
  );
  router.post(
    '/styles/categories/:id/remove',
    run(async (req, res) => {
      await service.removeCategory(
        entityId.parse(req.params.id),
        actor(req, res),
      );
      finish(req, res, '/admin/styles');
    }),
  );
  router.post(
    '/styles/:id/flags',
    run(async (req, res) => {
      const flags = z
        .object({ active: flag, featured: flag })
        .refine((v) => Object.values(v).some((x) => x !== undefined))
        .parse({ active: req.body.active, featured: req.body.featured });
      for (const key of Object.keys(flags))
        if (flags[key] === undefined) delete flags[key];
      const id = entityId.parse(req.params.id);
      await service.setStyleFlags(id, flags, actor(req, res));
      finish(req, res, '/admin/styles');
    }),
  );
  router.post(
    '/styles/:id/duplicate',
    run(async (req, res) => {
      const id = await service.duplicateStyle(
        entityId.parse(req.params.id),
        actor(req, res),
      );
      finish(req, res, '/admin/styles/' + id);
    }),
  );
  router.post(
    '/styles/:id/photos',
    run(async (req, res) => {
      const id = entityId.parse(req.params.id);
      await service.reorderStylePhotos(
        id,
        idList.parse(req.body.ids),
        actor(req, res),
      );
      finish(req, res, '/admin/styles/' + id + '#style-photos');
    }),
  );
  router.post(
    '/styles/:id/variants',
    run(async (req, res) => {
      const styleId = entityId.parse(req.params.id);
      await service.saveVariant(
        styleId,
        optionalId(req.body.id),
        durationFromHours(req.body),
        actor(req, res),
      );
      finish(req, res, '/admin/styles/' + styleId);
    }),
  );
  router.get(
    '/addons',
    run(async (req, res) => {
      const data = await service.all();
      const minutes = new Set([0, 15, 30, 45, 60, 90, 120]);
      for (const item of data.addons) minutes.add(item.durationMin);
      res.render('admin/manage/addons', {
        ...data,
        addons: data.addons.map((item) => ({
          ...item,
          time: item.durationMin
            ? '+' + durationLabel(item.durationMin)
            : 'No added time',
          styleNames: item.styleIds
            .map((id) => data.styles.find((style) => style.id === id)?.name)
            .filter(Boolean),
        })),
        minutes: [...minutes]
          .sort((a, b) => a - b)
          .map((value) => ({
            value,
            label: value ? durationLabel(value) : 'No added time',
          })),
      });
    }),
  );
  router.post(
    '/addons',
    run(async (req, res) => {
      await service.saveAddon(
        optionalId(req.body.id),
        req.body,
        actor(req, res),
      );
      finish(req, res, '/admin/addons');
    }),
  );
  router.post(
    '/addons/reorder',
    run(async (req, res) => {
      await service.reorderAddons(idList.parse(req.body.ids), actor(req, res));
      finish(req, res, '/admin/addons');
    }),
  );
  router.post(
    '/addons/:id/active',
    run(async (req, res) => {
      await service.setAddonActive(
        entityId.parse(req.params.id),
        z.boolean().parse(req.body.active),
        actor(req, res),
      );
      finish(req, res, '/admin/addons');
    }),
  );
  router.get(
    '/availability',
    run((req, res) => render(req, res, 'availability')),
  );
  router.post(
    '/availability',
    run(async (req, res) => {
      await service.saveAvailability(req.body, actor(req, res));
      finish(req, res, '/admin/availability');
    }),
  );
  router.post(
    '/availability/blocks',
    run(async (req, res) => {
      await service.addBlocks(req.body, actor(req, res));
      finish(req, res, '/admin/availability');
    }),
  );
  router.post(
    '/availability/blocks/:id/remove',
    run(async (req, res) => {
      await service.removeBlock(
        entityId.parse(req.params.id),
        checked.parse(req.body.series),
        actor(req, res),
      );
      finish(req, res, '/admin/availability');
    }),
  );
  router.get(
    '/gallery',
    run((req, res) => render(req, res, 'gallery')),
  );
  router.post(
    '/gallery/reorder',
    run(async (req, res) => {
      const ids = z.array(entityId).max(500).parse(req.body.ids);
      await service.reorderMedia(ids, actor(req, res));
      finish(req, res, '/admin/gallery');
    }),
  );
  const videoInput = z.object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(3).max(500),
    enabled: checked,
    showInWork: checked,
  });
  const videoUpload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 30 * 1024 * 1024,
      files: 2,
      fields: 8,
      fieldSize: 2000,
    },
  }).fields([
    { name: 'video', maxCount: 1 },
    { name: 'poster', maxCount: 1 },
  ]);
  router.post(
    '/gallery/videos/upload',
    (req, res, next) =>
      videoUpload(req, res, (error) =>
        next(
          error
            ? new ManagementError(
                'Choose a video under 30 MB and a cover image under 8 MB.',
              )
            : null,
        ),
      ),
    run(async (req, res) => {
      const input = videoInput.parse(req.body);
      let clip, poster;
      try {
        clip = await prepareCatalogVideo(
          req.files?.video?.[0]?.buffer,
          config.UPLOAD_DIR,
        );
        poster = await prepareCatalogImage(
          req.files?.poster?.[0]?.buffer,
          config.UPLOAD_DIR,
        );
        await service.saveVideo(
          null,
          input,
          {
            src: clip.src,
            poster: poster.path,
            posterVariants: poster.variants,
            width: clip.width,
            height: clip.height,
            durationSec: clip.durationSec,
          },
          actor(req, res),
        );
      } catch (error) {
        await clip?.cleanup();
        await poster?.cleanup();
        throw error;
      }
      finish(req, res, '/admin/gallery#videos');
    }),
  );
  router.post(
    '/gallery/videos/:id',
    run(async (req, res) => {
      const id = z
        .string()
        .regex(/^[a-z0-9-]{3,80}$/)
        .parse(req.params.id);
      await service.saveVideo(
        id,
        videoInput.parse(req.body),
        null,
        actor(req, res),
      );
      finish(req, res, '/admin/gallery#videos');
    }),
  );
  const returnPage = (req) =>
    req.body.returnTo === 'style' && req.body.returnStyle
      ? '/admin/styles/' +
        entityId.parse(req.body.returnStyle) +
        '#style-photos'
      : '/admin/gallery';
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 8 * 1024 * 1024,
      files: 1,
      fields: 10,
      fieldSize: 2000,
    },
  }).single('photo');
  router.post(
    '/gallery/upload',
    upload,
    run(async (req, res) => {
      const placement = photoPlacement(req.body);
      const input = z
        .object({
          alt: z.string().trim().min(3).max(500),
          kind: z.enum(['style', 'gallery']),
          styleId: text(20),
          sort: z.coerce.number().int().min(0).max(9999).default(0),
          returnTo: z.enum(['style', 'gallery']).default('style'),
        })
        .parse({ ...req.body, kind: placement.kind });
      const styleId = optionalId(input.styleId);
      if (input.kind === 'style' && !styleId)
        throw new ManagementError('Choose the style for this photo');
      const photo = await prepareCatalogImage(
        req.file?.buffer,
        config.UPLOAD_DIR,
      );
      let mediaId;
      try {
        const values = {
          path: photo.path,
          width: photo.width,
          height: photo.height,
          variants: photo.variants,
        };
        mediaId = await service.saveMedia(
          null,
          {
            ...values,
            alt: input.alt,
            kind: input.kind,
            showInWork: placement.showInWork,
            styleId,
            sort: input.sort,
          },
          actor(req, res),
        );
      } catch (error) {
        await photo.cleanup();
        throw error;
      }
      finish(
        req,
        res,
        styleId && input.kind === 'style' && input.returnTo === 'style'
          ? '/admin/styles/' + styleId + '#style-photos'
          : '/admin/gallery#photo-' + mediaId,
      );
    }),
  );
  router.post(
    '/gallery/:id/replace',
    upload,
    run(async (req, res) => {
      const id = entityId.parse(req.params.id);
      const returnTo = z
        .enum(['gallery', 'style'])
        .default('gallery')
        .parse(req.body.returnTo);
      await service.media(id);
      const photo = await prepareCatalogImage(
        req.file?.buffer,
        config.UPLOAD_DIR,
      );
      let updated;
      try {
        updated = await service.replaceMediaImage(id, photo, actor(req, res));
      } catch (error) {
        await photo.cleanup();
        throw error;
      }
      finish(
        req,
        res,
        returnTo === 'style' && updated.styleId
          ? '/admin/styles/' + updated.styleId + '#style-photos'
          : '/admin/gallery#photo-' + id,
      );
    }),
  );
  router.post(
    '/gallery/:id',
    run(async (req, res) => {
      const placement = photoPlacement(req.body);
      const v = z
        .object({
          alt: z.string().trim().min(3).max(500),
          sort: z.coerce.number().int().min(0).max(9999),
          styleId: text(20),
          kind: z.enum(['style', 'gallery']),
        })
        .parse({ ...req.body, kind: placement.kind });
      const styleId = optionalId(v.styleId);
      if (v.kind === 'style' && !styleId)
        throw new ManagementError('Choose a style');
      await service.saveMedia(
        entityId.parse(req.params.id),
        { ...v, styleId, showInWork: placement.showInWork },
        actor(req, res),
      );
      finish(req, res, returnPage(req));
    }),
  );
  router.post(
    '/gallery/:id/remove',
    run(async (req, res) => {
      await service.removeMedia(entityId.parse(req.params.id), actor(req, res));
      finish(req, res, returnPage(req));
    }),
  );
  router.get(
    '/redirects',
    run((req, res) => render(req, res, 'redirects')),
  );
  router.post(
    '/redirects',
    run(async (req, res) => {
      await service.saveRedirect(
        optionalId(req.body.id),
        req.body,
        actor(req, res),
      );
      finish(req, res, '/admin/redirects');
    }),
  );
  router.post(
    '/redirects/:id/remove',
    run(async (req, res) => {
      await service.removeRedirect(
        entityId.parse(req.params.id),
        actor(req, res),
      );
      finish(req, res, '/admin/redirects');
    }),
  );
  router.get(
    '/clients',
    run(async (req, res) => {
      const search = text(120).parse(req.query.search),
        page = z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .default(1)
          .parse(req.query.page);
      const rows = await service.clients(search, (page - 1) * 50);
      res.render('admin/manage/clients', {
        rows: rows.slice(0, 50),
        hasNext: rows.length > 50,
        page,
        search,
      });
    }),
  );
  router.get(
    '/clients/:id',
    run(async (req, res) =>
      res.render(
        'admin/manage/client',
        await service.client(entityId.parse(req.params.id)),
      ),
    ),
  );
  router.post(
    '/clients/:id',
    run(async (req, res) => {
      const id = entityId.parse(req.params.id);
      await service.saveClient(
        id,
        text(5000).parse(req.body.notes),
        actor(req, res),
      );
      finish(req, res, '/admin/clients/' + id);
    }),
  );
  router.get(
    '/seo',
    run(async (req, res) => {
      const { settings } = await service.all();
      const search = settings.search || {};
      const tag = (name) =>
        (search.verification || []).find((item) => item.name === name);
      const known = ['google-site-verification', 'msvalidate.01'];
      const other = (search.verification || []).find(
        (item) => !known.includes(item.name),
      );
      res.render('admin/manage/seo', {
        settings,
        search,
        seoPages,
        siteUrl: config.APP_URL.replace(/\/$/, ''),
        tags: {
          google: tag(known[0])?.content || '',
          bing: tag(known[1])?.content || '',
          other: other
            ? `<meta name="${other.name}" content="${other.content}">`
            : '',
        },
      });
    }),
  );
  router.post(
    '/seo',
    run(async (req, res) => {
      const pages = {};
      for (const path of Object.keys(seoPages)) {
        const line = (value, max) =>
          text(max).parse(value).replace(/\s+/g, ' ');
        const title = line(req.body['title:' + path], 120),
          description = line(req.body['description:' + path], 300);
        if (title || description) pages[path] = { title, description };
      }
      let verification;
      try {
        verification = [
          verificationTag(
            text(400).parse(req.body.google),
            'google-site-verification',
          ),
          verificationTag(text(400).parse(req.body.bing), 'msvalidate.01'),
          verificationTag(text(400).parse(req.body.other)),
        ].filter(Boolean);
      } catch (error) {
        if (error instanceof z.ZodError) throw error;
        throw new ManagementError(error.message);
      }
      await service.saveSettings(
        { search: { pages, verification } },
        actor(req, res),
      );
      finish(req, res, '/admin/seo');
    }),
  );
  router.get(
    '/settings',
    run((req, res) =>
      render(req, res, 'settings', {
        stripeMode: config.STRIPE_SECRET_KEY?.startsWith('sk_live_')
          ? 'Live'
          : 'Test',
      }),
    ),
  );
  router.post(
    '/settings',
    run(async (req, res) => {
      const v = z
        .object({
          name: z.string().trim().min(2).max(120),
          street: text(200),
          city: text(100),
          region: text(50),
          postalCode: text(20),
          phone: z
            .string()
            .regex(/^\+1\d{10}$/, 'Use a US number such as +14437434979'),
          instagram: socials,
          tiktok: socials,
          facebook: socials,
          google: socials,
          deposit: dollars.refine(
            (value) => value >= 50,
            'Deposit must be at least $0.50',
          ),
          holdMinutes: z.coerce.number().int().min(30).max(120),
          rescheduleHours: z.coerce.number().int().min(0).max(168),
          freeReschedules: z.coerce.number().int().min(0).max(10),
          depositRefundable: checked,
          policyText: text(5000),
          reminderHours: z.coerce.number().int().min(1).max(168),
          morningReminder: checked,
          winback: checked,
          adminAlertEmails: text(1000),
          balanceOnline: checked,
          balanceCash: checked,
          balanceZelle: checked,
          balanceCashapp: checked,
          balanceTerminal: checked,
        })
        .parse(req.body);
      const emails = v.adminAlertEmails
        .split(/[\s,;]+/)
        .filter(Boolean)
        .map((e) => z.email().parse(e));
      await service.saveSettings(
        {
          business: {
            name: v.name,
            street: v.street,
            city: v.city,
            region: v.region,
            postalCode: v.postalCode,
            phone: v.phone,
            social: {
              instagram: v.instagram,
              tiktok: v.tiktok,
              facebook: v.facebook,
              google: v.google,
            },
          },
          booking: {
            depositCents: v.deposit,
            holdMinutes: v.holdMinutes,
          },
          policy: {
            rescheduleHours: v.rescheduleHours,
            freeReschedules: v.freeReschedules,
            depositRefundable: v.depositRefundable,
            text: v.policyText,
          },
          emails: {
            reminderHours: v.reminderHours,
            morningReminder: v.morningReminder,
            winback: v.winback,
            adminAlertEmails: emails,
          },
          balanceOptions: {
            online: v.balanceOnline,
            cash: v.balanceCash,
            zelle: v.balanceZelle,
            cashapp: v.balanceCashapp,
            terminal: v.balanceTerminal,
          },
        },
        actor(req, res),
      );
      finish(req, res, '/admin/settings');
    }),
  );
  router.use((error, req, res, _next) => {
    req.log?.error({ err: error }, 'Owner management request failed');
    const message =
      error instanceof z.ZodError
        ? error.issues
            .slice(0, 3)
            .map((i) => i.message)
            .join(' · ')
        : (error.code || error.cause?.code) === 'ER_DUP_ENTRY'
          ? 'That name, link or size combination already exists.'
          : error.code === 'LIMIT_FILE_SIZE'
            ? 'Choose an image under 8 MB.'
            : error instanceof ManagementError
              ? error.message
              : 'Unable to save. Please refresh and try again.';
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    if (req.accepts(['html', 'json']) === 'json')
      return res.status(status).json({ message });
    res.status(status).render('admin/error', { error: message });
  });
  return router;
}
