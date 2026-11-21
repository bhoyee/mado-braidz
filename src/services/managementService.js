import { ManagementError } from './managementErrors.js';
import { and, eq, desc, asc, inArray, sql, lt, gt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import * as s from '../db/schema.js';
import {
  styleInput,
  variantInput,
  addonInput,
  redirectInput,
  availabilityInput,
  blockOccurrences,
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
      db.select().from(s.styles).orderBy(asc(s.styles.sort)),
      db.select().from(s.styleVariants).orderBy(asc(s.styleVariants.sort)),
      db.select().from(s.styleCategories).orderBy(asc(s.styleCategories.sort)),
      db.select().from(s.addons).orderBy(asc(s.addons.sort), asc(s.addons.id)),
      db.select().from(s.addonStyles),
      db
        .select()
        .from(s.media)
        .where(inArray(s.media.kind, ['style', 'gallery']))
        .orderBy(asc(s.media.sort)),
      db.select().from(s.settings),
      db.select().from(s.redirects),
      db
        .select()
        .from(s.timeBlocks)
        .where(gt(s.timeBlocks.endAt, new Date()))
        .orderBy(asc(s.timeBlocks.startAt))
        .limit(500),
    ]).then(
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
        media,
        settings: Object.fromEntries(
          settings.map((r) => [
            r.key,
            typeof r.value === 'string' ? JSON.parse(r.value) : r.value,
          ]),
        ),
        redirects,
        blocks,
      }),
    );
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
    async replaceMediaImage(id, image, actor) {
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
          path: image.path,
          width: image.width,
          height: image.height,
          variants: {
            ...image.variants,
            ...(previous?.size ? { size: previous.size } : {}),
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
      const { fromPrice, ...input } = styleInput.parse(raw);
      return db.transaction(async (tx) => {
        exists(
          (
            await tx
              .select()
              .from(s.styleCategories)
              .where(eq(s.styleCategories.id, input.categoryId))
          )[0],
        );
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
        const values = {
          ...input,
          fromPriceCents: fromPrice,
          updatedAt: new Date(),
        };
        if (input.active && !input.priceOnConsultation) {
          const options = id
            ? await tx
                .select()
                .from(s.styleVariants)
                .where(
                  and(
                    eq(s.styleVariants.styleId, id),
                    eq(s.styleVariants.active, true),
                  ),
                )
            : [];
          if (!options.length)
            throw new ManagementError(
              'Add a price option before publishing, or choose price on consultation.',
            );
        }
        if (id)
          await tx.update(s.styles).set(values).where(eq(s.styles.id, id));
        else
          id = (await tx.insert(s.styles).values(values).$returningId())[0].id;
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
        const values = { ...v, priceCents: price, styleId };
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
        await tx
          .update(s.styles)
          .set({ updatedAt: new Date() })
          .where(eq(s.styles.id, styleId));
      });
    },
    async saveAddon(id, raw, actor) {
      const { price, styleIds, ...v } = addonInput.parse(raw);
      if (!v.appliesToAll && !styleIds.length)
        throw new ManagementError('Choose at least one style');
      return db.transaction(async (tx) => {
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
        const old = Object.fromEntries(
          (await tx.select().from(s.settings).for('update')).map((r) => [
            r.key,
            typeof r.value === 'string' ? JSON.parse(r.value) : r.value,
          ]),
        );
        const fmt = (t) =>
          DateTime.fromISO('2026-01-01T' + t).toFormat('h:mm a');
        const summary = Object.entries(v.weekly)
          .map(
            ([day, h]) =>
              day.slice(0, 3) +
              ': ' +
              (h.closed ? 'Closed' : fmt(h.open) + '–' + fmt(h.close)),
          )
          .join(' · ');
        await setting(
          tx,
          'hours',
          {
            ...old.hours,
            customHours: true,
            weekly: v.weekly,
            summary,
            description: summary,
            daysLabel: 'Opening hours',
            timeLabel: 'See weekly schedule',
            sundayLabel: 'Eastern time',
          },
          actor,
        );
        await setting(tx, 'booking', { ...old.booking, ...v.booking }, actor);
      });
    },
    async saveSettings(values, actor) {
      await db.transaction(async (tx) => {
        for (const [key, value] of Object.entries(values))
          await setting(tx, key, value, actor);
      });
    },
    async addBlocks(raw, actor) {
      const rows = blockOccurrences(raw),
        series = raw.repeat === 'weekly' ? 'weekly:' + randomUUID() : null;
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
        for (const row of rows) {
          const conflict = await tx
            .select({ id: s.bookings.id })
            .from(s.bookings)
            .where(
              and(
                lt(s.bookings.startAt, row.endAt),
                gt(s.bookings.blockEndAt, row.startAt),
                sql`(status IN ('confirmed','completed') OR (status = 'pending_payment' AND hold_expires_at > ${clock()}))`,
              ),
            )
            .for('update');
          if (conflict.length)
            throw new ManagementError(
              'This time overlaps an existing appointment or payment hold. Move the appointment first.',
            );
        }
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
    async saveMedia(id, values, actor) {
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
          await tx.update(s.media).set(values).where(eq(s.media.id, id));
        } else
          id = (await tx.insert(s.media).values(values).$returningId())[0].id;
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
    async clients(search = '', offset = 0) {
      return db
        .select()
        .from(s.clients)
        .where(
          sql`LOCATE(${search}, CONCAT(name,' ',email,' ',phone_e164)) > 0`,
        )
        .orderBy(desc(s.clients.id))
        .limit(51)
        .offset(offset);
    },
    async client(id) {
      const client = exists(
        (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0],
      );
      const visits = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.clientId, id))
        .orderBy(desc(s.bookings.startAt));
      const jobs = await db
        .select()
        .from(s.jobs)
        .where(
          sql`JSON_EXTRACT(${s.jobs.payload}, '$.clientId') = ${id} OR JSON_EXTRACT(${s.jobs.payload}, '$.bookingId') IN (SELECT id FROM bookings WHERE client_id = ${id})`,
        );
      return {
        client,
        visits,
        winbacks: jobs.filter((r) => r.type.includes('winback')),
      };
    },
    async saveClient(id, notes, actor) {
      await db.transaction(async (tx) => {
        const before = exists(
          (
            await tx
              .select()
              .from(s.clients)
              .where(eq(s.clients.id, id))
              .for('update')
          )[0],
        );
        await tx.update(s.clients).set({ notes }).where(eq(s.clients.id, id));
        await audit(
          tx,
          actor,
          'client',
          id,
          { notes: before.notes },
          { notes },
        );
      });
    },
  };
}
