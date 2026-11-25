import { ManagementConfirm, ManagementError } from './managementErrors.js';
import { outsideHours, weekSummary } from './openingHours.js';
import { and, eq, desc, asc, inArray, sql, lt, gt, gte, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { studioVideos } from './studioVideos.js';
import { DateTime } from 'luxon';
import * as s from '../db/schema.js';
import { orderStyles, priceChanges, priceSort } from './styleSummary.js';
import { createCatalogService } from './catalogService.js';
import { createClientService } from './clientService.js';
import {
  KEEP_REMOVED_DAYS,
  cleanFocus,
  isRemoved,
  photoVariants,
} from './photoState.js';
import {
  styleInput,
  variantInput,
  addonInput,
  redirectInput,
  availabilityInput,
  blockOccurrences,
  checked,
  specialDayInput,
} from './managementValidation.js';

export function createManagementService(db, clock = () => new Date()) {
  const exists = (row) => {
    if (!row) throw new ManagementError('Item not found');
    return row;
  };
  const audit = (tx, actor, entity, entityId, before, after) =>
    tx.insert(s.auditLog).values({
      adminId: actor.id,
      ip: actor.ip,
      entity,
      entityId,
      action: before ? 'update' : 'create',
      before: before || null,
      after,
    });
  const all = () =>
    Promise.all([
      db
        .select()
        .from(s.styles)
        .orderBy(desc(s.styles.createdAt), desc(s.styles.id)),
      db.select().from(s.styleVariants).orderBy(asc(s.styleVariants.sort)),
      db.select().from(s.styleCategories).orderBy(asc(s.styleCategories.sort)),
      db.select().from(s.addons).orderBy(asc(s.addons.sort), asc(s.addons.id)),
      db.select().from(s.addonStyles),
      db
        .select()
        .from(s.media)
        .where(inArray(s.media.kind, ['style', 'gallery']))
        .orderBy(asc(s.media.sort), asc(s.media.id)),
      db.select().from(s.settings),
      db.select().from(s.redirects),
      db
        .select()
        .from(s.timeBlocks)
        .where(gt(s.timeBlocks.endAt, new Date()))
        .orderBy(asc(s.timeBlocks.startAt))
        .limit(500),
    ])
      .then(
        ([
          styles,
          variants,
          categories,
          addons,
          links,
          media,
          settings,
          redirects,
          blocks,
        ]) => ({
          styles,
          variants,
          categories,
          addons: addons.map((a) => ({
            ...a,
            styleIds: links
              .filter((l) => l.addonId === a.id)
              .map((l) => l.styleId),
          })),
          media: media.filter((row) => !isRemoved(row)),
          removedMedia: media.filter(isRemoved),
          settings: Object.fromEntries(
            settings.map((r) => [
              r.key,
              typeof r.value === 'string' ? JSON.parse(r.value) : r.value,
            ]),
          ),
          redirects,
          blocks,
        }),
      )
      .then((data) => ({
        ...data,
        styles: orderStyles(data.styles, data.settings.catalog?.styleOrder),
        videos: studioVideos(data.settings),
      }));
  // A published style must always have a price a client can book.
  async function ensureBookable(tx, styleId, message) {
    const [style] = await tx
      .select()
      .from(s.styles)
      .where(eq(s.styles.id, styleId));
    if (!style.active || style.priceOnConsultation) return;
    const [option] = await tx
      .select({ id: s.styleVariants.id })
      .from(s.styleVariants)
      .where(
        and(
          eq(s.styleVariants.styleId, styleId),
          eq(s.styleVariants.active, true),
        ),
      )
      .limit(1);
    if (!option)
      throw new ManagementError(
        message ||
          'Keep at least one price on, or hide the style from the website first.',
      );
  }
  async function lockPhotos(tx, ids, removed = false) {
    const rows = await tx
      .select()
      .from(s.media)
      .where(
        and(
          inArray(s.media.id, ids),
          inArray(s.media.kind, ['style', 'gallery']),
        ),
      )
      .for('update');
    if (
      rows.length !== new Set(ids).size ||
      rows.some((row) => isRemoved(row) !== removed)
    )
      throw new ManagementError('Refresh the photos and try again');
    return rows;
  }
  // `workIds` are the photos clients see on Our Work now, so a photo keeps its
  // place there unless the owner changes it.
  async function updatePhotos(ids, input, actor) {
    const { alt, styleId, showOnStyle, showInWork, focus, workIds } = input;
    return db.transaction(async (tx) => {
      const rows = await lockPhotos(tx, ids);
      if (styleId)
        exists(
          (
            await tx
              .select({ id: s.styles.id })
              .from(s.styles)
              .where(eq(s.styles.id, styleId))
          )[0],
        );
      for (const row of rows) {
        const before = photoVariants(row);
        const tag = styleId === undefined ? row.styleId : styleId;
        const style = showOnStyle ?? (row.kind === 'style' && !before.hidden);
        const work = showInWork ?? workIds.has(row.id);
        if (style && !tag)
          throw new ManagementError(
            'Choose a style to show a photo on a style page.',
          );
        const variants = { ...before, showInWork: work };
        delete variants.hidden;
        if (!style && !work) variants.hidden = true;
        // A size photo belongs to one style only.
        if (tag !== row.styleId) delete variants.size;
        if (focus !== undefined) {
          delete variants.focus;
          const clean = cleanFocus(focus);
          if (clean) variants.focus = clean;
        }
        const values = {
          ...(alt === undefined ? {} : { alt }),
          styleId: tag || null,
          kind: style ? 'style' : work ? 'gallery' : row.kind,
          variants,
        };
        await tx.update(s.media).set(values).where(eq(s.media.id, row.id));
        await audit(tx, actor, 'media', row.id, row, values);
      }
    });
  }
  const named = (rows) =>
    [...new Map(rows.map((row) => [row.id, row])).values()]
      .slice(0, 4)
      .map(
        (row) =>
          `${row.name}, ${DateTime.fromJSDate(row.startAt, { zone: 'America/New_York' }).toFormat('ccc LLL d, h:mm a')}`,
      )
      .join('; ') + (rows.length > 4 ? `; and ${rows.length - 4} more` : '');
  const heldSettings = async (tx) =>
    Object.fromEntries(
      (await tx.select().from(s.settings).for('update')).map((row) => [
        row.key,
        typeof row.value === 'string' ? JSON.parse(row.value) : row.value,
      ]),
    );
  // New hours never move a booking, so show which ones they would leave behind.
  async function warnOutside(tx, hours, oldHours, acknowledged, onlyDate) {
    if (checked.parse(acknowledged)) return;
    const upcoming = await tx
      .select({
        id: s.bookings.id,
        startAt: s.bookings.startAt,
        endAt: s.bookings.endAt,
        name: s.clients.name,
      })
      .from(s.bookings)
      .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
      .where(
        and(
          gt(s.bookings.startAt, clock()),
          sql`(${s.bookings.status} = 'confirmed' OR (${s.bookings.status} = 'pending_payment' AND ${s.bookings.holdExpiresAt} > ${clock()}))`,
        ),
      )
      .orderBy(asc(s.bookings.startAt));
    const already = new Set(
      outsideHours(upcoming, oldHours).map((row) => row.id),
    );
    const left = outsideHours(upcoming, hours).filter(
      (row) =>
        !already.has(row.id) &&
        (!onlyDate ||
          DateTime.fromJSDate(row.startAt, {
            zone: 'America/New_York',
          }).toISODate() === onlyDate),
    );
    if (left.length)
      throw new ManagementConfirm(
        left.length === 1
          ? '1 appointment is outside these hours'
          : `${left.length} appointments are outside these hours`,
        `${named(left)}. They stay booked unless you move them. Clients are not emailed.`,
      );
  }
  async function newSlug(tx, name, table, fallback) {
    const base =
      String(name || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 160)
        .replace(/^-|-$/g, '') || fallback;
    let slug = base,
      suffix = 2;
    const taken = async () =>
      (
        await tx
          .select({ id: table.id })
          .from(table)
          .where(eq(table.slug, slug))
          .limit(1)
      ).length ||
      (table === s.styles &&
        (
          await tx
            .select({ id: s.redirects.id })
            .from(s.redirects)
            .where(eq(s.redirects.source, '/styles/' + slug))
            .limit(1)
        ).length);
    while (await taken()) slug = `${base}-${suffix++}`;
    return slug;
  }
  // Saves the whole price grid. Rows left out are untouched; a cleared price
  // switches that option off but keeps it for past bookings.
  async function savePrices(tx, styleId, prices, actor) {
    const rows = await tx
      .select()
      .from(s.styleVariants)
      .where(eq(s.styleVariants.styleId, styleId));
    const seen = new Set();
    for (const raw of prices) {
      const wanted = {
        size: raw.size || null,
        length: raw.length || null,
      };
      const before = raw.id
        ? exists(rows.find((row) => row.id === Number(raw.id)))
        : rows.find(
            (row) => row.size === wanted.size && row.length === wanted.length,
          );
      const blank = String(raw.price ?? '').trim() === '';
      if (blank && !before) continue;
      const { price, ...option } = variantInput.parse({
        size: before ? before.size || '' : raw.size || '',
        length: before ? before.length || '' : raw.length || '',
        label: raw.label ?? before?.label ?? '',
        price: blank ? (before.priceCents / 100).toFixed(2) : raw.price,
        durationMin: raw.durationMin ?? '',
        active: blank ? false : raw.active,
      });
      const key = `${option.size}|${option.length}`;
      if (seen.has(key))
        throw new ManagementError('A size and length appears twice.');
      seen.add(key);
      const values = {
        ...option,
        styleId,
        priceCents: price,
        sort: priceSort(option.size, option.length),
      };
      if (!before) {
        const id = (
          await tx.insert(s.styleVariants).values(values).$returningId()
        )[0].id;
        await audit(tx, actor, 'variant', id, null, values);
        continue;
      }
      await tx
        .update(s.styleVariants)
        .set(values)
        .where(eq(s.styleVariants.id, before.id));
      if (
        before.priceCents !== values.priceCents ||
        before.active !== values.active ||
        (before.durationMin ?? null) !== values.durationMin ||
        (before.label || '') !== values.label
      )
        await audit(tx, actor, 'variant', before.id, before, values);
    }
  }
  async function setting(tx, key, value, actor) {
    const [before] = await tx
      .select()
      .from(s.settings)
      .where(eq(s.settings.key, key))
      .for('update');
    const prior =
      typeof before?.value === 'string'
        ? JSON.parse(before.value)
        : before?.value;
    value = { ...prior, ...value };
    await tx
      .insert(s.settings)
      .values({ key, value, updatedAt: new Date(), updatedBy: actor.id })
      .onDuplicateKeyUpdate({
        set: { value, updatedAt: new Date(), updatedBy: actor.id },
      });
    await audit(
      tx,
      actor,
      'settings',
      0,
      before ? { key, value: prior } : null,
      { key, value },
    );
  }
  return {
    all,
    async saveVideo(id, input, asset, actor) {
      return db.transaction(async (tx) => {
        await tx
          .insert(s.settings)
          .values({
            key: 'videos',
            value: { items: [] },
            updatedAt: new Date(),
          })
          .onDuplicateKeyUpdate({ set: { key: 'videos' } });
        const [row] = await tx
          .select()
          .from(s.settings)
          .where(eq(s.settings.key, 'videos'))
          .for('update');
        const value =
          typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
        const before = id
          ? exists(studioVideos({ videos: value }).find((v) => v.id === id))
          : null;
        if (!before && !asset)
          throw new ManagementError('Choose a video and cover image');
        const video = {
          ...before,
          ...asset,
          id: before?.id || randomUUID(),
          ...input,
          builtin: before?.builtin || false,
        };
        if (!before) video.locations = ['Our Work'];
        const items = (value.items || []).filter((v) => v.id !== video.id);
        if (items.length >= 100)
          throw new ManagementError(
            'The video library is full. Contact the website administrator.',
          );
        await setting(tx, 'videos', { items: [...items, video] }, actor);
        return video;
      });
    },
    async media(id) {
      const row = exists(
        (
          await db
            .select()
            .from(s.media)
            .where(
              and(
                eq(s.media.id, id),
                inArray(s.media.kind, ['style', 'gallery']),
              ),
            )
        )[0],
      );
      return {
        ...row,
        variants:
          typeof row.variants === 'string'
            ? JSON.parse(row.variants)
            : row.variants,
      };
    },
    async replaceMediaImage(id, image, actor, edited = false) {
      return db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.media)
              .where(
                and(
                  eq(s.media.id, id),
                  inArray(s.media.kind, ['style', 'gallery']),
                ),
              )
              .for('update')
          )[0],
        );
        const previous =
          typeof before.variants === 'string'
            ? JSON.parse(before.variants)
            : before.variants;
        const patch = {
          // A real photo is no longer described as a reference.
          ...(edited
            ? {}
            : {
                alt:
                  before.alt.replace(/^AI hairstyle reference:\s*/i, '') ||
                  before.alt,
              }),
          path: image.path,
          width: image.width,
          height: image.height,
          variants: {
            ...image.variants,
            // Rotating or cropping does not change what a photo is.
            ...(edited && previous?.origin ? { origin: previous.origin } : {}),
            ...(previous?.size ? { size: previous.size } : {}),
            ...(typeof previous?.showInWork === 'boolean'
              ? { showInWork: previous.showInWork }
              : {}),
            ...(previous?.hidden ? { hidden: true } : {}),
          },
        };
        await tx.update(s.media).set(patch).where(eq(s.media.id, id));
        const after = { ...before, ...patch };
        await audit(tx, actor, 'media', id, before, after);
        if (before.styleId && before.kind === 'style') {
          await tx
            .update(s.styles)
            .set({ updatedAt: new Date() })
            .where(eq(s.styles.id, before.styleId));
          await audit(
            tx,
            actor,
            'style',
            before.styleId,
            { photoId: id, path: before.path },
            { photoId: id, path: patch.path },
          );
        }
        return after;
      });
    },
    async lastEdit(id) {
      return (
        await db
          .select({ name: s.admins.name, at: s.auditLog.createdAt })
          .from(s.auditLog)
          .innerJoin(s.admins, eq(s.admins.id, s.auditLog.adminId))
          .where(
            and(eq(s.auditLog.entity, 'style'), eq(s.auditLog.entityId, id)),
          )
          .orderBy(desc(s.auditLog.id))
          .limit(1)
      )[0];
    },
    async saveStyle(id, raw, actor) {
      return db.transaction(async (tx) => {
        const before = id
          ? exists(
              (
                await tx
                  .select()
                  .from(s.styles)
                  .where(eq(s.styles.id, id))
                  .for('update')
              )[0],
            )
          : null;
        let slug = raw.slug || before?.slug;
        if (!slug) slug = await newSlug(tx, raw.name, s.styles, 'style');
        const { fromPrice, ...input } = styleInput.parse({ ...raw, slug });
        const firstPrice =
          !id && !input.priceOnConsultation && raw.initialPrice
            ? variantInput.parse({
                price: raw.initialPrice,
                size: raw.initialSize || '',
                length: raw.initialLength || '',
                durationMin: '',
                active: true,
              })
            : null;
        exists(
          (
            await tx
              .select()
              .from(s.styleCategories)
              .where(eq(s.styleCategories.id, input.categoryId))
          )[0],
        );
        const values = {
          ...input,
          sort: before?.sort ?? 0,
          fromPriceCents: fromPrice,
          updatedAt: new Date(),
        };
        if (id)
          await tx.update(s.styles).set(values).where(eq(s.styles.id, id));
        else
          id = (await tx.insert(s.styles).values(values).$returningId())[0].id;
        if (firstPrice) {
          const { price, ...option } = firstPrice;
          const variantValues = {
            ...option,
            styleId: id,
            priceCents: price,
            sort: 0,
          };
          const variantId = (
            await tx
              .insert(s.styleVariants)
              .values(variantValues)
              .$returningId()
          )[0].id;
          await audit(tx, actor, 'variant', variantId, null, variantValues);
        }
        if (Array.isArray(raw.prices))
          await savePrices(tx, id, raw.prices, actor);
        await ensureBookable(
          tx,
          id,
          'Add a price option before publishing, or choose price on consultation.',
        );
        if (before && before.slug !== input.slug) {
          const source = '/styles/' + before.slug,
            target = '/styles/' + input.slug;
          await tx.delete(s.redirects).where(eq(s.redirects.source, target));
          await tx
            .update(s.redirects)
            .set({ target, updatedAt: new Date() })
            .where(eq(s.redirects.target, source));
          await tx
            .insert(s.redirects)
            .values({ source, target, updatedAt: new Date() })
            .onDuplicateKeyUpdate({ set: { target, updatedAt: new Date() } });
        }
        await audit(tx, actor, 'style', id, before, values);
        return id;
      });
    },
    async saveVariant(styleId, id, raw, actor) {
      const { price, ...v } = variantInput.parse(raw);
      return db.transaction(async (tx) => {
        exists(
          (
            await tx
              .select()
              .from(s.styles)
              .where(eq(s.styles.id, styleId))
              .for('update')
          )[0],
        );
        const rows = await tx
          .select()
          .from(s.styleVariants)
          .where(eq(s.styleVariants.styleId, styleId));
        const before = id ? exists(rows.find((r) => r.id === id)) : null;
        if (
          rows.some(
            (r) => r.id !== id && r.size === v.size && r.length === v.length,
          )
        )
          throw new ManagementError(
            'That size and length already exists. Edit its row instead.',
          );
        const values = {
          ...v,
          sort:
            before?.sort ?? Math.max(-1, ...rows.map((row) => row.sort)) + 1,
          priceCents: price,
          styleId,
        };
        if (id)
          await tx
            .update(s.styleVariants)
            .set(values)
            .where(eq(s.styleVariants.id, id));
        else
          id = (
            await tx.insert(s.styleVariants).values(values).$returningId()
          )[0].id;
        await audit(tx, actor, 'variant', id, before, values);
        await audit(
          tx,
          actor,
          'style',
          styleId,
          { variantId: id },
          { variantId: id, ...values },
        );
        await ensureBookable(tx, styleId);
        await tx
          .update(s.styles)
          .set({ updatedAt: new Date() })
          .where(eq(s.styles.id, styleId));
      });
    },
    async setStyleFlags(id, flags, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.styles)
              .where(eq(s.styles.id, id))
              .for('update')
          )[0],
        );
        const values = { ...flags, updatedAt: new Date() };
        await tx.update(s.styles).set(values).where(eq(s.styles.id, id));
        await ensureBookable(
          tx,
          id,
          'Add a price option before publishing, or choose price on consultation.',
        );
        await audit(
          tx,
          actor,
          'style',
          id,
          { active: before.active, featured: before.featured },
          flags,
        );
      });
    },
    async reorderStyles(ids, actor) {
      await db.transaction(async (tx) => {
        const rows = await tx.select({ id: s.styles.id }).from(s.styles);
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== rows.length ||
          ids.some((id) => !rows.some((row) => row.id === id))
        )
          throw new ManagementError('Refresh the style list and try again');
        await setting(tx, 'catalog', { styleOrder: ids }, actor);
      });
    },
    async duplicateStyle(id, actor) {
      return db.transaction(async (tx) => {
        const source = exists(
          (await tx.select().from(s.styles).where(eq(s.styles.id, id)))[0],
        );
        const name = `${source.name} (copy)`.slice(0, 255);
        const now = new Date();
        const values = {
          categoryId: source.categoryId,
          name,
          slug: await newSlug(tx, name, s.styles, 'style'),
          shortDesc: source.shortDesc,
          longDesc: source.longDesc,
          durationMin: source.durationMin,
          priceOnConsultation: source.priceOnConsultation,
          fromPriceCents: source.fromPriceCents,
          featured: false,
          // Hidden until the owner has renamed it and added photos.
          active: false,
          updatedAt: now,
        };
        const copyId = (
          await tx.insert(s.styles).values(values).$returningId()
        )[0].id;
        const options = await tx
          .select()
          .from(s.styleVariants)
          .where(eq(s.styleVariants.styleId, id));
        for (const option of options) {
          const copy = { ...option, styleId: copyId };
          delete copy.id;
          const variantId = (
            await tx.insert(s.styleVariants).values(copy).$returningId()
          )[0].id;
          await audit(tx, actor, 'variant', variantId, null, copy);
        }
        const links = await tx
          .select()
          .from(s.addonStyles)
          .where(eq(s.addonStyles.styleId, id));
        if (links.length)
          await tx
            .insert(s.addonStyles)
            .values(
              links.map((l) => ({ addonId: l.addonId, styleId: copyId })),
            );
        await audit(tx, actor, 'style', copyId, null, values);
        return copyId;
      });
    },
    async priceHistory(styleId) {
      const variants = await db
        .select()
        .from(s.styleVariants)
        .where(eq(s.styleVariants.styleId, styleId));
      if (!variants.length) return [];
      const rows = await db
        .select({
          at: s.auditLog.createdAt,
          name: s.admins.name,
          entityId: s.auditLog.entityId,
          before: s.auditLog.before,
          after: s.auditLog.after,
        })
        .from(s.auditLog)
        .innerJoin(s.admins, eq(s.admins.id, s.auditLog.adminId))
        .where(
          and(
            eq(s.auditLog.entity, 'variant'),
            inArray(
              s.auditLog.entityId,
              variants.map((v) => v.id),
            ),
          ),
        )
        .orderBy(desc(s.auditLog.id))
        .limit(60);
      return priceChanges(rows, variants).slice(0, 30);
    },
    async reorderStylePhotos(styleId, ids, actor) {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(s.media)
          .where(inArray(s.media.kind, ['style', 'gallery']))
          .orderBy(asc(s.media.sort), asc(s.media.id))
          .for('update');
        const own = rows.filter(
          (row) =>
            row.styleId === styleId && row.kind === 'style' && !isRemoved(row),
        );
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== own.length ||
          ids.some((id) => !own.some((row) => row.id === id))
        )
          throw new ManagementError('Refresh the photos and try again');
        // This style's photos swap places; the rest of the library stays put.
        const next = [...ids];
        const order = rows.map((row) =>
          own.includes(row) ? next.shift() : row.id,
        );
        for (const [sort, id] of order.entries())
          if (rows.find((row) => row.id === id).sort !== sort)
            await tx.update(s.media).set({ sort }).where(eq(s.media.id, id));
        await audit(
          tx,
          actor,
          'media_order',
          styleId,
          own.map((row) => row.id),
          ids,
        );
      });
    },
    async saveCategory(id, rawName, actor) {
      const name = String(rawName || '').trim();
      if (!name || name.length > 40)
        throw new ManagementError('Enter a category name of up to 40 letters.');
      return db.transaction(async (tx) => {
        const rows = await tx.select().from(s.styleCategories).for('update');
        const before = id ? exists(rows.find((row) => row.id === id)) : null;
        if (
          rows.some(
            (row) =>
              row.id !== id && row.name.toLowerCase() === name.toLowerCase(),
          )
        )
          throw new ManagementError('That category already exists.');
        // The web address stays the same when a category is renamed.
        const values = before
          ? { name }
          : {
              name,
              slug: await newSlug(tx, name, s.styleCategories, 'category'),
              sort: Math.max(-1, ...rows.map((row) => row.sort)) + 1,
            };
        if (before)
          await tx
            .update(s.styleCategories)
            .set(values)
            .where(eq(s.styleCategories.id, id));
        else
          id = (
            await tx.insert(s.styleCategories).values(values).$returningId()
          )[0].id;
        await audit(tx, actor, 'category', id, before, values);
        return id;
      });
    },
    async removeCategory(id, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.styleCategories)
              .where(eq(s.styleCategories.id, id))
              .for('update')
          )[0],
        );
        const [used] = await tx
          .select({ id: s.styles.id })
          .from(s.styles)
          .where(eq(s.styles.categoryId, id))
          .limit(1);
        if (used)
          throw new ManagementError(
            'Move its styles to another category first.',
          );
        await tx.delete(s.styleCategories).where(eq(s.styleCategories.id, id));
        await audit(tx, actor, 'category', id, before, { removed: true });
      });
    },
    async setAddonActive(id, active, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.addons)
              .where(eq(s.addons.id, id))
              .for('update')
          )[0],
        );
        await tx.update(s.addons).set({ active }).where(eq(s.addons.id, id));
        await audit(
          tx,
          actor,
          'addon',
          id,
          { active: before.active },
          { active },
        );
      });
    },
    async reorderAddons(ids, actor) {
      await db.transaction(async (tx) => {
        const rows = await tx.select().from(s.addons).for('update');
        if (
          new Set(ids).size !== ids.length ||
          ids.length !== rows.length ||
          ids.some((id) => !rows.some((row) => row.id === id))
        )
          throw new ManagementError('Refresh the extras and try again');
        for (const [sort, id] of ids.entries())
          await tx.update(s.addons).set({ sort }).where(eq(s.addons.id, id));
        await audit(
          tx,
          actor,
          'addon_order',
          0,
          rows.map((row) => ({ id: row.id, sort: row.sort })),
          ids,
        );
      });
    },
    async saveAddon(id, raw, actor) {
      return db.transaction(async (tx) => {
        // The website finds some extras by this name, so it never changes.
        const [current] = id
          ? await tx.select().from(s.addons).where(eq(s.addons.id, id))
          : [];
        const slug =
          current?.slug ||
          raw.slug ||
          (await newSlug(tx, raw.name, s.addons, 'extra'));
        const { price, styleIds, ...v } = addonInput.parse({ ...raw, slug });
        if (!v.appliesToAll && !styleIds.length)
          throw new ManagementError('Choose at least one style');
        if (
          styleIds.length &&
          (
            await tx
              .select({ id: s.styles.id })
              .from(s.styles)
              .where(inArray(s.styles.id, styleIds))
          ).length !== new Set(styleIds).size
        )
          throw new ManagementError('Choose valid styles');
        const before = id
          ? exists(
              (
                await tx
                  .select()
                  .from(s.addons)
                  .where(eq(s.addons.id, id))
                  .for('update')
              )[0],
            )
          : null;
        const next = before
          ? before.sort
          : Number(
              (
                await tx
                  .select({
                    value: sql`COALESCE(MAX(${s.addons.sort}), -1) + 1`,
                  })
                  .from(s.addons)
              )[0].value,
            );
        const values = { ...v, sort: next, priceCents: price };
        if (id)
          await tx.update(s.addons).set(values).where(eq(s.addons.id, id));
        else
          id = (await tx.insert(s.addons).values(values).$returningId())[0].id;
        await tx.delete(s.addonStyles).where(eq(s.addonStyles.addonId, id));
        if (!v.appliesToAll)
          await tx.insert(s.addonStyles).values(
            [...new Set(styleIds)].map((styleId) => ({
              styleId,
              addonId: id,
            })),
          );
        await audit(tx, actor, 'addon', id, before, { ...values, styleIds });
        return id;
      });
    },
    async saveAvailability(raw, actor) {
      const v = availabilityInput(raw);
      await db.transaction(async (tx) => {
        const old = await heldSettings(tx);
        const hours = {
          ...old.hours,
          customHours: true,
          weekly: v.weekly,
          summary: weekSummary(v.weekly),
          description: weekSummary(v.weekly),
        };
        await warnOutside(tx, hours, old.hours, raw.acknowledge);
        await setting(tx, 'hours', hours, actor);
        await setting(tx, 'booking', { ...old.booking, ...v.booking }, actor);
      });
    },
    async saveSpecialDay(raw, actor) {
      const day = specialDayInput.parse(raw);
      const today = DateTime.fromJSDate(clock(), {
        zone: 'America/New_York',
      }).toISODate();
      if (day.date < today)
        throw new ManagementError('Choose today or a later date.');
      await db.transaction(async (tx) => {
        const old = await heldSettings(tx);
        const special = [
          ...(old.hours.special || []).filter(
            (item) => item.date !== day.date && item.date >= today,
          ),
          day,
        ].sort((a, b) => a.date.localeCompare(b.date));
        if (special.length > 60)
          throw new ManagementError('Keep up to 60 special days.');
        const hours = { ...old.hours, special };
        await warnOutside(tx, hours, old.hours, raw.acknowledge, day.date);
        await setting(tx, 'hours', hours, actor);
      });
    },
    async removeSpecialDay(date, actor) {
      await db.transaction(async (tx) => {
        const old = await heldSettings(tx);
        const special = (old.hours.special || []).filter(
          (item) => item.date !== date,
        );
        await setting(tx, 'hours', { ...old.hours, special }, actor);
      });
    },
    owners: () =>
      db
        .select({
          id: s.admins.id,
          name: s.admins.name,
          email: s.admins.email,
          role: s.admins.role,
          lastLoginAt: s.admins.lastLoginAt,
        })
        .from(s.admins)
        .where(eq(s.admins.role, 'owner'))
        .orderBy(asc(s.admins.id)),
    // Only facts this site can check for itself.
    async health(cutoff = new Date(0)) {
      const now = clock();
      const day = new Date(+now - 86400000);
      const overdue = and(
        eq(s.jobs.status, 'pending'),
        lt(s.jobs.runAt, new Date(+now - 20 * 60000)),
      );
      // The same rule the sender uses: messages from before email was switched
      // on stay unsent on purpose, so they are not late.
      const sendable = or(
        eq(s.jobs.type, 'refundConflict'),
        gte(s.jobs.createdAt, cutoff),
        and(
          inArray(s.jobs.type, ['reminder', 'winback']),
          gte(s.jobs.runAt, cutoff),
        ),
      );
      const [late, failed, heartbeat, emails, lastEmail, lastEvent, alerts] =
        await Promise.all([
          db
            .select({ count: sql`COUNT(*)` })
            .from(s.jobs)
            .where(and(overdue, sendable)),
          db
            .select({ count: sql`COUNT(*)` })
            .from(s.jobs)
            .where(
              and(
                eq(s.jobs.status, 'failed'),
                gt(s.jobs.runAt, day),
                sendable,
                inArray(s.jobs.type, [
                  'email',
                  'reminder',
                  'winback',
                  'push',
                  'whatsapp',
                  'refundConflict',
                ]),
              ),
            ),
          db
            .select({ at: s.settings.updatedAt })
            .from(s.settings)
            .where(eq(s.settings.key, 'jobs_heartbeat')),
          db
            .select({
              failed: sql`COALESCE(SUM(${s.emailLog.status} IN ('failed','unknown','bounced','blocked')), 0)`,
              sent: sql`COUNT(*)`,
            })
            .from(s.emailLog)
            .where(gt(s.emailLog.createdAt, day)),
          db
            .select({ at: s.emailLog.createdAt })
            .from(s.emailLog)
            .where(
              inArray(s.emailLog.status, [
                'sent',
                'delivered',
                'opened',
                'clicked',
              ]),
            )
            .orderBy(desc(s.emailLog.id))
            .limit(1),
          db
            .select({ at: s.stripeEvents.receivedAt })
            .from(s.stripeEvents)
            .orderBy(desc(s.stripeEvents.receivedAt))
            .limit(1),
          db.select({ count: sql`COUNT(*)` }).from(s.pushSubscriptions),
        ]);
      return {
        late: Number(late[0].count),
        failed: Number(failed[0].count),
        lastRun: heartbeat[0]?.at || null,
        emailsSent: Number(emails[0].sent),
        emailsFailed: Number(emails[0].failed),
        lastEmail: lastEmail[0]?.at || null,
        lastCardEvent: lastEvent[0]?.at || null,
        alertDevices: Number(alerts[0].count),
      };
    },
    async saveSettings(values, actor) {
      await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(values))
          await setting(tx, key, value, actor);
      });
    },
    async addBlocks(raw, actor) {
      const rows = blockOccurrences(raw),
        series =
          raw.repeat === 'weekly'
            ? 'weekly:' + randomUUID()
            : rows.length > 1
              ? 'range:' + randomUUID()
              : null;
      await db.transaction(async (tx) => {
        const dates = [
          ...new Set(
            rows.map((r) =>
              DateTime.fromJSDate(r.startAt, {
                zone: 'America/New_York',
              }).toISODate(),
            ),
          ),
        ].sort();
        for (const date of dates) {
          await tx.execute(
            sql`INSERT IGNORE INTO calendar_locks (date) VALUES (${date})`,
          );
          await tx
            .select()
            .from(s.calendarLocks)
            .where(eq(s.calendarLocks.date, date))
            .for('update');
        }
        const clashes = [];
        for (const row of rows) {
          const conflict = await tx
            .select({
              id: s.bookings.id,
              startAt: s.bookings.startAt,
              name: s.clients.name,
            })
            .from(s.bookings)
            .innerJoin(s.clients, eq(s.bookings.clientId, s.clients.id))
            .where(
              and(
                lt(s.bookings.startAt, row.endAt),
                gte(s.bookings.startAt, row.startAt),
                sql`(${s.bookings.status} IN ('confirmed','completed') OR (${s.bookings.status} = 'pending_payment' AND hold_expires_at > ${clock()}))`,
              ),
            )
            .for('update');
          if (conflict.length) clashes.push(...conflict);
        }
        if (clashes.length)
          throw new ManagementError(
            `An existing appointment or payment hold starts in this time: ${named(clashes)}. Move ${clashes.length === 1 ? 'it' : 'them'} first.`,
          );
        for (const row of rows) {
          const [created] = await tx
            .insert(s.timeBlocks)
            .values({ ...row, repeatRule: series, createdBy: actor.id })
            .$returningId();
          await audit(tx, actor, 'time_block', created.id, null, row);
        }
      });
    },
    async removeBlock(id, series, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.timeBlocks)
              .where(eq(s.timeBlocks.id, id))
              .for('update')
          )[0],
        );
        const filter =
          series && before.repeatRule
            ? eq(s.timeBlocks.repeatRule, before.repeatRule)
            : eq(s.timeBlocks.id, id);
        await tx.delete(s.timeBlocks).where(filter);
        await audit(tx, actor, 'time_block', id, before, {
          removed: true,
          series,
        });
      });
    },
    async saveMedia(id, rawValues, actor) {
      const { showInWork, ...values } = rawValues;
      return db.transaction(async (tx) => {
        if (values.styleId)
          exists(
            (
              await tx
                .select()
                .from(s.styles)
                .where(eq(s.styles.id, values.styleId))
            )[0],
          );
        let before = null;
        if (id) {
          before = exists(
            (
              await tx
                .select()
                .from(s.media)
                .where(
                  and(
                    eq(s.media.id, id),
                    inArray(s.media.kind, ['style', 'gallery']),
                  ),
                )
                .for('update')
            )[0],
          );
          if (typeof showInWork === 'boolean') {
            const previous =
              typeof before.variants === 'string'
                ? JSON.parse(before.variants)
                : before.variants;
            values.variants = { ...previous, ...values.variants, showInWork };
          }
          await tx.update(s.media).set(values).where(eq(s.media.id, id));
        } else {
          if (typeof showInWork === 'boolean')
            values.variants = { ...values.variants, showInWork };
          id = (await tx.insert(s.media).values(values).$returningId())[0].id;
        }
        await audit(tx, actor, 'media', id, before, values);
        return id;
      });
    },
    async reorderMedia(ids, actor) {
      await db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(s.media)
          .where(inArray(s.media.kind, ['style', 'gallery']))
          .for('update');
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !rows.some((r) => r.id === id))
        )
          throw new ManagementError('Refresh the photo list and try again');
        for (const [sort, id] of ids.entries())
          await tx.update(s.media).set({ sort }).where(eq(s.media.id, id));
        await audit(
          tx,
          actor,
          'media_order',
          0,
          rows.map((r) => ({ id: r.id, sort: r.sort })),
          ids,
        );
      });
    },
    publicCatalog: () => createCatalogService(db).load(),
    // One save for everything in the photo window.
    async savePhoto(id, input, actor) {
      return updatePhotos([id], input, actor);
    },
    async placePhotos(ids, input, actor) {
      return updatePhotos(ids, input, actor);
    },
    async trashMedia(ids, actor) {
      await db.transaction(async (tx) => {
        const rows = await lockPhotos(tx, ids);
        for (const row of rows) {
          const variants = {
            ...photoVariants(row),
            removedAt: clock().toISOString(),
          };
          await tx
            .update(s.media)
            .set({ variants })
            .where(eq(s.media.id, row.id));
          await audit(tx, actor, 'media', row.id, row, { removed: true });
        }
      });
    },
    async restoreMedia(ids, actor) {
      await db.transaction(async (tx) => {
        for (const row of await lockPhotos(tx, ids, true)) {
          const variants = { ...photoVariants(row) };
          delete variants.removedAt;
          await tx
            .update(s.media)
            .set({ variants })
            .where(eq(s.media.id, row.id));
          await audit(tx, actor, 'media', row.id, { removed: true }, variants);
        }
      });
    },
    // Photos removed more than a week ago are deleted; the cleanup job then
    // removes their files.
    async purgeRemovedMedia() {
      const before = +clock() - KEEP_REMOVED_DAYS * 86400000;
      const rows = await db
        .select()
        .from(s.media)
        .where(inArray(s.media.kind, ['style', 'gallery']));
      const old = rows.filter(
        (row) =>
          isRemoved(row) && +new Date(photoVariants(row).removedAt) < before,
      );
      if (old.length)
        await db.delete(s.media).where(
          inArray(
            s.media.id,
            old.map((row) => row.id),
          ),
        );
      return old.length;
    },
    async saveWorkOrder(order, actor) {
      await db.transaction((tx) => setting(tx, 'ourWork', { order }, actor));
    },
    async setVideoFlags(id, flags, actor) {
      const video = exists((await all()).videos.find((v) => v.id === id));
      return this.saveVideo(
        id,
        {
          title: video.title,
          description: video.description,
          enabled: flags.enabled ?? video.enabled,
          showInWork: flags.showInWork ?? Boolean(video.showInWork),
        },
        null,
        actor,
      );
    },
    async setVideoCover(id, image, actor) {
      const video = exists((await all()).videos.find((v) => v.id === id));
      return this.saveVideo(
        id,
        {
          title: video.title,
          description: video.description,
          enabled: video.enabled,
          showInWork: Boolean(video.showInWork),
        },
        {
          poster: image.path,
          posterVariants: image.variants,
          customCover: true,
        },
        actor,
      );
    },
    async removeVideo(id, actor) {
      await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(s.settings)
          .where(eq(s.settings.key, 'videos'))
          .for('update');
        const value =
          typeof row?.value === 'string' ? JSON.parse(row.value) : row?.value;
        const video = exists(
          studioVideos({ videos: value }).find((v) => v.id === id),
        );
        if (video.builtin)
          throw new ManagementError(
            'This video is part of the website. Hide it instead.',
          );
        await setting(
          tx,
          'videos',
          { items: value.items.filter((v) => v.id !== id) },
          actor,
        );
      });
    },
    async removeMedia(id, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.media)
              .where(
                and(
                  eq(s.media.id, id),
                  inArray(s.media.kind, ['style', 'gallery']),
                ),
              )
              .for('update')
          )[0],
        );
        await tx.delete(s.media).where(eq(s.media.id, id));
        await audit(tx, actor, 'media', id, before, { removed: true });
      });
    },
    async saveRedirect(id, raw, actor) {
      const v = redirectInput.parse(raw);
      await db.transaction(async (tx) => {
        const active = await tx
          .select()
          .from(s.styles)
          .where(eq(s.styles.active, true));
        if (
          [
            '/',
            '/styles',
            '/gallery',
            '/about',
            '/contact',
            '/policies',
            '/terms',
            '/privacy',
            '/sitemap.xml',
            ...active.map((r) => '/styles/' + r.slug),
          ].includes(v.source)
        )
          throw new ManagementError('That source is an active page');
        const rows = await tx.select().from(s.redirects).for('update');
        const before = id ? exists(rows.find((r) => r.id === id)) : null;
        const map = new Map(
          rows.filter((r) => r.id !== id).map((r) => [r.source, r.target]),
        );
        map.set(v.source, v.target);
        for (const source of map.keys()) {
          const seen = new Set();
          let path = source;
          while (map.has(path)) {
            if (seen.has(path))
              throw new ManagementError('Redirects cannot form a loop');
            seen.add(path);
            path = map.get(path);
          }
        }
        if (id)
          await tx
            .update(s.redirects)
            .set({ ...v, updatedAt: new Date() })
            .where(eq(s.redirects.id, id));
        else
          id = (
            await tx
              .insert(s.redirects)
              .values({ ...v, updatedAt: new Date() })
              .$returningId()
          )[0].id;
        await audit(tx, actor, 'redirect', id, before, v);
      });
    },
    async removeRedirect(id, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx.select().from(s.redirects).where(eq(s.redirects.id, id))
          )[0],
        );
        await tx.delete(s.redirects).where(eq(s.redirects.id, id));
        await audit(tx, actor, 'redirect', id, before, { removed: true });
      });
    },
    people: createClientService(db, clock),
  };
}
