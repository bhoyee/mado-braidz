import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import {
  entityId,
  durationFromHours,
  checked,
} from '../../services/managementValidation.js';
import { prepareCatalogImage } from '../../services/catalogImages.js';
import { prepareCatalogVideo } from '../../services/catalogVideos.js';
import { publicSettings } from '../../db/public-defaults.js';
import { DateTime } from 'luxon';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  ManagementConfirm,
  ManagementError,
} from '../../services/managementErrors.js';
import { rangeLabel } from '../../services/openingHours.js';
import { groupBlocks, healthChecks } from '../../services/settingsView.js';
import { seoPages, verificationTag } from '../../services/pageSeo.js';
import { photoPlacement } from '../../services/photoPlacement.js';
import { isShown, libraryPhoto } from '../../services/photoState.js';
import { decorateCatalog, studioName, workItems } from '../public/index.js';
import { holdSchema } from '../public/booking.js';
import {
  CLIENT_TAGS,
  clientSorts,
  clientViews,
} from '../../services/clientService.js';
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
  z
    .url('Paste the full link, starting with https://')
    .refine(
      (v) => v.startsWith('https://'),
      'Paste the full link, starting with https://',
    ),
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
  const stylePhotos = async (id, data) => {
    const workIds = await workPhotoIds();
    return data.media
      .filter((photo) => photo.styleId === id && photo.kind === 'style')
      .map((photo) =>
        libraryPhoto(photo, {
          styles: data.styles,
          media: data.media,
          workIds,
        }),
      );
  };
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
        photos: await stylePhotos(id, data),
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
    '/styles/:id/delete',
    run(async (req, res) => {
      await service.deleteStyle(entityId.parse(req.params.id), actor(req, res));
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
  router.get(
    '/time-off',
    run(async (req, res) => {
      const data = await service.all();
      const today = DateTime.now().setZone('America/New_York').toISODate();
      res.render('admin/manage/time-off', {
        ...data,
        today,
        specialDays: (data.settings.hours.special || [])
          .filter((day) => day.date >= today)
          .map((day) => ({
            ...day,
            label: DateTime.fromISO(day.date).toFormat('cccc, LLLL d, yyyy'),
            text: rangeLabel(day),
          })),
        blockGroups: groupBlocks(data.blocks),
      });
    }),
  );
  router.post(
    '/time-off/special',
    run(async (req, res) => {
      await service.saveSpecialDay(req.body, actor(req, res));
      finish(req, res, '/admin/time-off');
    }),
  );
  router.post(
    '/time-off/special/remove',
    run(async (req, res) => {
      await service.removeSpecialDay(
        z.iso.date().parse(req.body.date),
        actor(req, res),
      );
      finish(req, res, '/admin/time-off');
    }),
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
      finish(req, res, '/admin/time-off');
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
      finish(req, res, '/admin/time-off');
    }),
  );
  // Exactly what clients see on Our Work, in order.
  async function publicWork() {
    const view = decorateCatalog(await service.publicCatalog());
    return workItems(
      view.suppliedStyles,
      view.gallery,
      Object.values(view.studioClips),
      view.workOrder,
    );
  }
  const workPhotoIds = async () =>
    new Set(
      (await publicWork())
        .map((item) => Number(/^photo:(\d+)$/.exec(item.key || '')?.[1]))
        .filter(Boolean),
    );
  router.get(
    '/gallery',
    run(async (req, res) => {
      await service.purgeRemovedMedia();
      const [data, work] = await Promise.all([service.all(), publicWork()]);
      const workIds = new Set(
        work.map((item) => Number(/^photo:(\d+)$/.exec(item.key || '')?.[1])),
      );
      const context = { styles: data.styles, media: data.media, workIds };
      const photos = data.media.map((photo) => libraryPhoto(photo, context));
      const referenced = new Set(
        photos
          .filter((photo) => photo.cover && photo.reference)
          .map((photo) => photo.styleId),
      );
      res.render('admin/manage/gallery', {
        ...data,
        photos,
        removed: data.removedMedia.map((photo) => libraryPhoto(photo, context)),
        stylesWithoutPhotos: data.styles.filter(
          (style) =>
            !data.media.some(
              (photo) =>
                photo.kind === 'style' &&
                photo.styleId === style.id &&
                isShown(photo),
            ),
        ),
        referenceStyles: data.styles.filter((style) =>
          referenced.has(style.id),
        ),
        work: work
          .filter((item) => item.key)
          .map((item) => ({
            key: item.key,
            film: item.type === 'film',
            title: item.type === 'film' ? item.title : item.label,
            image:
              item.type === 'film'
                ? item.poster
                : item.photo.variants?.sizes?.[0]?.path || item.photo.path,
            focusClass: item.photo?.focusClass || '',
          })),
      });
    }),
  );
  const photoIds = z.array(entityId).min(1).max(200);
  const photoChange = z.object({
    styleId: z.union([entityId, z.null()]).optional(),
    showOnStyle: z.boolean().optional(),
    showInWork: z.boolean().optional(),
  });
  router.post(
    '/gallery/place',
    run(async (req, res) => {
      const change = photoChange
        .refine((v) => Object.values(v).some((x) => x !== undefined))
        .parse({
          styleId: req.body.styleId,
          showOnStyle: req.body.showOnStyle,
          showInWork: req.body.showInWork,
        });
      await service.placePhotos(
        photoIds.parse(req.body.ids),
        { ...change, workIds: await workPhotoIds() },
        actor(req, res),
      );
      finish(req, res, '/admin/gallery');
    }),
  );
  router.post(
    '/gallery/trash',
    run(async (req, res) => {
      await service.trashMedia(photoIds.parse(req.body.ids), actor(req, res));
      finish(req, res, '/admin/gallery');
    }),
  );
  router.post(
    '/gallery/restore',
    run(async (req, res) => {
      await service.restoreMedia(photoIds.parse(req.body.ids), actor(req, res));
      finish(req, res, '/admin/gallery');
    }),
  );
  router.post(
    '/gallery/work-order',
    run(async (req, res) => {
      const order = z
        .array(z.string().regex(/^(photo:\d+|film:[a-z0-9-]{3,80})$/))
        .min(1)
        .max(600)
        .refine((keys) => new Set(keys).size === keys.length)
        .parse(req.body.order);
      await service.saveWorkOrder(order, actor(req, res));
      finish(req, res, '/admin/gallery#work');
    }),
  );
  router.post(
    '/gallery/reorder',
    run(async (req, res) => {
      const ids = z.array(entityId).max(500).parse(req.body.ids);
      await service.reorderMedia(ids, actor(req, res));
      finish(req, res, '/admin/gallery');
    }),
  );
  const videoId = z.string().regex(/^[a-z0-9-]{3,80}$/);
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
      const id = videoId.parse(req.params.id);
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
    '/gallery/:id/details',
    run(async (req, res) => {
      const id = entityId.parse(req.params.id);
      const change = photoChange
        .extend({
          alt: z
            .string()
            .trim()
            .min(3, 'Describe the photo in a few words')
            .max(500),
          focus: z.object({
            x: z.number().min(0).max(100),
            y: z.number().min(0).max(100),
          }),
        })
        .parse(req.body);
      await service.savePhoto(
        id,
        { ...change, workIds: await workPhotoIds() },
        actor(req, res),
      );
      finish(req, res, '/admin/gallery#photo-' + id);
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
        updated = await service.replaceMediaImage(
          id,
          photo,
          actor(req, res),
          req.body.edited === '1',
        );
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
      await service.trashMedia(
        [entityId.parse(req.params.id)],
        actor(req, res),
      );
      finish(req, res, returnPage(req));
    }),
  );
  router.post(
    '/gallery/videos/:id/flags',
    run(async (req, res) => {
      const flags = z
        .object({ enabled: flag, showInWork: flag })
        .refine((v) => Object.values(v).some((x) => x !== undefined))
        .parse({
          enabled: req.body.enabled,
          showInWork: req.body.showInWork,
        });
      const id = videoId.parse(req.params.id);
      await service.setVideoFlags(id, flags, actor(req, res));
      finish(req, res, '/admin/gallery#videos');
    }),
  );
  router.post(
    '/gallery/videos/:id/cover',
    upload,
    run(async (req, res) => {
      const id = videoId.parse(req.params.id);
      const image = await prepareCatalogImage(
        req.file?.buffer,
        config.UPLOAD_DIR,
      );
      try {
        await service.setVideoCover(id, image, actor(req, res));
      } catch (error) {
        await image.cleanup();
        throw error;
      }
      finish(req, res, '/admin/gallery#video-' + id);
    }),
  );
  router.post(
    '/gallery/videos/:id/remove',
    run(async (req, res) => {
      await service.removeVideo(videoId.parse(req.params.id), actor(req, res));
      finish(req, res, '/admin/gallery#videos');
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
  const people = service.people;
  function clientFilter(query) {
    return z
      .object({
        search: z.string().trim().max(80).default(''),
        view: z.enum(Object.keys(clientViews)).default('all'),
        sort: z.enum(Object.keys(clientSorts)).default('recent'),
        page: z.coerce.number().int().min(1).max(100000).default(1),
      })
      .parse(
        Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== ''),
        ),
      );
  }
  router.get(
    '/clients',
    run(async (req, res) => {
      const filter = clientFilter(req.query);
      const data = await people.directory(filter);
      const link = (page) =>
        '?' + new URLSearchParams({ ...filter, page: String(page) });
      const exported = new URLSearchParams({ ...filter });
      exported.delete('page');
      res.render('admin/manage/clients', {
        ...data,
        filter,
        page: filter.page,
        views: Object.entries(clientViews),
        viewLabel: clientViews[filter.view],
        sorts: Object.entries(clientSorts),
        previous: link(Math.max(1, filter.page - 1)),
        next: link(filter.page + 1),
        exportQuery: exported.toString(),
      });
    }),
  );
  router.get(
    '/clients/export',
    run(async (req, res) => {
      const { rows } = await people.directory({
        ...clientFilter(req.query),
        page: 1,
        all: true,
      });
      const cell = (value) =>
        '"' +
        String(value ?? '')
          .replace(/^[=+\-@\t\r]/, (c) => "'" + c)
          .replaceAll('"', '""') +
        '"';
      const day = (value) =>
        value
          ? new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/New_York',
            }).format(value)
          : '';
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="mado-clients.csv"',
      });
      res.send(
        'Name,Email,Phone,Visits,No-shows,Last visit,Next visit,Paid USD,Balance USD,Repeat,Salon news\r\n' +
          rows
            .map((p) =>
              [
                p.name,
                p.email,
                p.phone,
                p.visitCount,
                p.noShows,
                day(p.lastVisit),
                day(p.nextVisit?.startAt),
                (p.spentCents / 100).toFixed(2),
                (p.balanceCents / 100).toFixed(2),
                p.repeat ? 'Yes' : 'No',
                p.news ? 'Opted in' : 'No',
              ]
                .map(cell)
                .join(','),
            )
            .join('\r\n') +
          '\r\n',
      );
    }),
  );
  router.get(
    '/clients/:id',
    run(async (req, res) => {
      const id = entityId.parse(req.params.id);
      const profile = await people.profile(id);
      // One address per person, whichever of their records was opened.
      if (profile.id !== id)
        return res.redirect(303, '/admin/clients/' + profile.id);
      res.render('admin/manage/client', {
        ...profile,
        tagChoices: [...new Set([...CLIENT_TAGS, ...profile.tags])],
        changeNames: {
          edit: 'Details edited',
          notes: 'Notes or tags saved',
          update: 'Notes saved',
          unsubscribe: 'Salon news stopped',
          join: 'Joined with another record',
          'undo-join': 'Join undone',
          'keep-apart': 'Kept apart from another client',
          'remove-details': 'Personal details removed',
        },
      });
    }),
  );
  const clientAction = (path, handler) =>
    router.post(
      '/clients/:id/' + path,
      run(async (req, res) => {
        const id = entityId.parse(req.params.id);
        await handler(id, req, res);
        finish(req, res, '/admin/clients/' + id);
      }),
    );
  const contactInput = holdSchema.pick({
    name: true,
    email: true,
    phone: true,
  });
  clientAction('details', (id, req, res) =>
    people.saveDetails(
      id,
      contactInput.parse({
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
      }),
      actor(req, res),
    ),
  );
  clientAction('notes', (id, req, res) => {
    let tags;
    try {
      tags = JSON.parse(req.body.tags || '[]');
    } catch {
      throw new ManagementError('Refresh the page and try again.');
    }
    return people.saveNotes(
      id,
      {
        notes: text(5000).parse(req.body.notes),
        tags: z
          .array(z.string().trim().min(1).max(30))
          .max(10, 'Choose up to 10 tags')
          .parse(tags),
      },
      actor(req, res),
    );
  });
  clientAction('stop-news', (id, req, res) =>
    people.stopNews(id, actor(req, res)),
  );
  for (const [path, how] of [
    ['join', 'join'],
    ['apart', 'apart'],
  ])
    clientAction(path, (id, req, res) =>
      people.link(id, entityId.parse(req.body.other), how, actor(req, res)),
    );
  clientAction('unjoin', (id, req, res) =>
    people.unlink(
      id,
      z
        .string()
        .regex(/^\d+-\d+$/)
        .parse(req.body.pair)
        .split('-')
        .map(Number),
      actor(req, res),
    ),
  );
  clientAction('remove', (id, req, res) => {
    z.literal('REMOVE', 'Type REMOVE to confirm').parse(req.body.confirm);
    return people.removeDetails(id, actor(req, res));
  });
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
  const settingsPage = (path, view, extra = () => ({})) =>
    router.get(
      path,
      run(async (req, res) => render(req, res, view, await extra())),
    );
  const stripeMode = config.STRIPE_SECRET_KEY?.startsWith('sk_live_')
    ? 'live'
    : 'test';
  settingsPage('/settings', 'settings');
  settingsPage('/settings/payments', 'settings-payments', async () => {
    const { settings } = await service.all();
    return {
      stripeMode,
      holdChoices: [
        ...new Set([30, 45, 60, 90, 120, settings.booking.holdMinutes]),
      ].sort((a, b) => a - b),
      recipients: {
        name: config.MANUAL_PAYMENT_NAME,
        zelle: config.ZELLE_RECIPIENT,
        cashapp: config.CASHAPP_CASHTAG,
      },
    };
  });
  settingsPage('/settings/policies', 'settings-policies', async () => ({
    rules: {
      ...publicSettings.policy,
      ...(await service.all()).settings.policy,
    },
  }));
  settingsPage('/settings/emails', 'settings-emails', async () => {
    const { settings } = await service.all();
    const saved = settings.emails?.reminderHours || 48;
    return {
      reminderChoices: [...new Set([24, 48, 72, saved])]
        .sort((a, b) => a - b)
        .map((hours) => [
          hours,
          hours % 24
            ? `${hours} hours before`
            : `${hours / 24} day${hours === 24 ? '' : 's'} before`,
        ]),
    };
  });
  settingsPage('/settings/health', 'settings-health', async () => ({
    checks: healthChecks(
      await service.health(new Date(config.NOTIFICATIONS_START_AT || 0)),
      config,
    ),
  }));
  const saveSection = (path, schema, values) =>
    router.post(
      '/settings/' + path,
      run(async (req, res) => {
        const input = schema.parse(req.body);
        const current = (await service.all()).settings;
        await service.saveSettings(values(input, current), actor(req, res));
        finish(
          req,
          res,
          path === 'business' ? '/admin/settings' : '/admin/settings/' + path,
        );
      }),
    );
  const whole = (min, max, message) =>
    z.coerce.number(message).int(message).min(min, message).max(max, message);
  saveSection(
    'business',
    z.object({
      name: z
        .string()
        .trim()
        .min(2, 'Enter the business name')
        .max(120)
        .transform(studioName),
      phone: z.string().transform((value, context) => {
        const phone = parsePhoneNumberFromString(value, 'US');
        if (phone?.country === 'US' && phone.isValid()) return phone.number;
        context.addIssue({
          code: 'custom',
          message: 'Enter a US number, such as (443) 743-4979',
        });
        return z.NEVER;
      }),
      street: z.string().trim().min(2, 'Enter the street address').max(200),
      city: z.string().trim().min(2, 'Enter the city').max(100),
      region: z.string().trim().min(2, 'Enter the state').max(50),
      postalCode: z
        .string()
        .trim()
        .regex(/^\d{5}(?:-\d{4})?$/, 'Enter a ZIP code, such as 20706'),
      instagram: socials,
      tiktok: socials,
      facebook: socials,
      google: socials,
    }),
    ({ instagram, tiktok, facebook, google, ...business }, current) => ({
      business: {
        ...business,
        social: {
          ...current.business.social,
          instagram,
          tiktok,
          facebook,
          google,
        },
      },
    }),
  );
  saveSection(
    'payments',
    z.object({
      deposit: z
        .string()
        .trim()
        .regex(/^\d{1,6}(?:\.\d{1,2})?$/, 'Enter an amount, such as 30')
        .transform((value) => Math.round(Number(value) * 100))
        .refine((value) => value >= 50, 'The deposit must be at least $0.50'),
      holdMinutes: whole(30, 120, 'Choose 30 to 120 minutes'),
      depositZelle: checked,
      depositCashapp: checked,
      balanceOnline: checked,
      balanceCash: checked,
      balanceZelle: checked,
      balanceCashapp: checked,
      balanceTerminal: checked,
    }),
    (v, current) => {
      const before = current.depositOptions || {};
      const changed =
        (before.zelle !== false) !== v.depositZelle ||
        (before.cashapp !== false) !== v.depositCashapp;
      return {
        booking: { depositCents: v.deposit, holdMinutes: v.holdMinutes },
        depositOptions: {
          zelle: v.depositZelle,
          cashapp: v.depositCashapp,
          ...(changed ? { changedAt: new Date().toISOString() } : {}),
        },
        balanceOptions: {
          online: v.balanceOnline,
          cash: v.balanceCash,
          zelle: v.balanceZelle,
          cashapp: v.balanceCashapp,
          terminal: v.balanceTerminal,
        },
      };
    },
  );
  saveSection(
    'policies',
    z.object({
      rescheduleHours: whole(0, 168, 'Enter 0 to 168 hours'),
      freeReschedules: whole(0, 10, 'Enter 0 to 10'),
      depositRefundable: checked,
      cancelHours: whole(0, 168, 'Enter 0 to 168 hours'),
      lateFeeMinutes: whole(0, 120, 'Enter 0 to 120 minutes'),
      lateFee: z
        .string()
        .trim()
        .regex(/^(?:\d{1,4}(?:\.\d{1,2})?)?$/, 'Enter an amount, such as 10')
        .transform((value) => Math.round(Number(value || 0) * 100)),
      policyText: text(5000),
    }),
    ({ policyText, lateFee, ...policy }) => ({
      policy: { ...policy, lateFeeCents: lateFee, text: policyText },
    }),
  );
  saveSection(
    'emails',
    z.object({
      reminderHours: whole(1, 168, 'Choose 1 to 168 hours'),
      morningReminder: checked,
      winback: checked,
      adminAlertEmails: text(1000).transform((value, context) => {
        const list = [
          ...new Set(
            value
              .split(/[\s,;]+/)
              .filter(Boolean)
              .map((item) => item.toLowerCase()),
          ),
        ];
        const bad = list.find((item) => !z.email().safeParse(item).success);
        if (bad || list.length > 10)
          context.addIssue({
            code: 'custom',
            message: bad
              ? `${bad} is not an email address`
              : 'Keep up to 10 addresses',
          });
        return list;
      }),
    }),
    (emails) => ({ emails }),
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
    const status =
      error.code === 'LIMIT_FILE_SIZE'
        ? 413
        : error instanceof ManagementConfirm
          ? 409
          : 400;
    if (req.accepts(['html', 'json']) === 'json')
      return res.status(status).json({
        message,
        ...(error.confirm ? { confirm: error.confirm } : {}),
        // Lets the page mark the exact boxes to fix.
        ...(error instanceof z.ZodError
          ? {
              fields: Object.fromEntries(
                error.issues
                  .filter((issue) => issue.path.length === 1)
                  .map((issue) => [issue.path[0], issue.message]),
              ),
            }
          : {}),
      });
    res.status(status).render('admin/error', { error: message });
  });
  return router;
}
