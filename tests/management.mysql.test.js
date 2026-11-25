import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { readFile, rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/index.js';
import * as s from '../src/db/schema.js';
import {
  clearAppointments,
  previewClear,
} from '../src/services/clearAppointments.js';
import { createManagementService } from '../src/services/managementService.js';
import { createBookingRepository } from '../src/services/bookingRepository.js';
import { createBookingService } from '../src/services/bookingService.js';
import { createApp } from '../src/app.js';
import { createAdminRepository } from '../src/services/adminRepository.js';
import { createNotificationService } from '../src/services/notificationService.js';
import { createNotificationRepository } from '../src/services/notificationRepository.js';
import { createCatalogService } from '../src/services/catalogService.js';
import { parseEnv } from '../src/config/env.js';
import { paymentConfig, fakeStripe } from './fixtures/stripe.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';

describe.skipIf(process.env.BOOKING_DATABASE_TEST !== '1')(
  'owner management with a real disposable MySQL database',
  () => {
    let admin, db, pool, service, repository, bookings, app, agent, token;
    const database = 'mado_catalog_test_' + randomBytes(6).toString('hex');
    const uploadDir = resolve('tmp', 'management-upload-' + database);
    const actor = { id: 1, role: 'owner', ip: '127.0.0.1' },
      password = 'Owner-management-test-password!';
    beforeAll(async () => {
      const url = new URL(
        process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      );
      admin = await mysql.createConnection(url.toString());
      await admin.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
      );
      url.pathname = '/' + database;
      ({ db, pool } = createDatabase(url.toString()));
      await migrate(db, { migrationsFolder: 'src/db/migrations' });
      await db.insert(s.admins).values({
        id: 1,
        name: 'Test Owner',
        email: 'owner@example.test',
        passwordHash: await argon2.hash(password),
        role: 'owner',
      });
      const { data } = await memoryBookingRepository();
      await db.insert(s.styleCategories).values(data.categories);
      for (const style of data.styles) {
        await db.insert(s.styles).values({
          id: style.id,
          categoryId: data.categories.find((c) => c.slug === style.category).id,
          name: style.name,
          slug: style.slug,
          durationMin: style.durationMin,
          priceOnConsultation: !!style.priceOnConsultation,
          updatedAt: new Date(),
        });
        if (style.variants.length)
          await db
            .insert(s.styleVariants)
            .values(style.variants.map((v) => ({ ...v, styleId: style.id })));
      }
      await db.insert(s.addons).values(data.addons);
      await db.insert(s.settings).values(
        Object.entries(data.settings).map(([key, value]) => ({
          key,
          value,
          updatedAt: new Date(),
        })),
      );
      service = createManagementService(db, () => now.toJSDate());
      repository = createBookingRepository(db);
      bookings = createBookingService(repository, () => now, 'x'.repeat(32));
      const config = parseEnv({
        ...paymentConfig,
        DATABASE_URL: url.toString(),
        UPLOAD_DIR: uploadDir,
      });
      app = createApp({
        config,
        notificationService: createNotificationService(
          createNotificationRepository(db),
          config,
        ),
        catalog: createCatalogService(db),
        bookingRepository: repository,
        adminRepository: createAdminRepository(db),
        managementService: service,
        stripeProvider: fakeStripe(),
      });
      agent = request.agent(app);
      const login = await agent.get('/admin/login');
      token = login.text.match(/name="_csrf" value="([^"]+)"/)[1];
      await agent
        .post('/admin/login')
        .type('form')
        .send({ _csrf: token, email: 'owner@example.test', password })
        .expect(303);
      const page = await agent.get('/admin/styles');
      token = page.text.match(/name="csrf-token" content="([^"]+)"/)[1];
    }, 30000);
    it('places new extras last and preserves their position when edited without display-order input', async () => {
      const before = await db.select().from(s.addons);
      const input = {
        name: 'Test extra',
        slug: 'automatic-order-extra',
        price: '15',
        durationMin: 0,
        active: true,
        appliesToAll: true,
      };
      const id = await service.saveAddon(null, input, actor);
      const [created] = await db
        .select()
        .from(s.addons)
        .where(eq(s.addons.id, id));
      expect(created.sort).toBe(
        Math.max(-1, ...before.map((row) => row.sort)) + 1,
      );
      await service.saveAddon(id, { ...input, name: 'Updated extra' }, actor);
      const [updated] = await db
        .select()
        .from(s.addons)
        .where(eq(s.addons.id, id));
      expect(updated.sort).toBe(created.sort);
      expect(updated.name).toBe('Updated extra');
    });
    afterAll(async () => {
      await pool?.end();
      if (
        uploadDir.startsWith(
          resolve('tmp') + sep + 'management-upload-mado_catalog_test_',
        )
      )
        await rm(uploadDir, { recursive: true, force: true });
      if (admin) {
        if (!/^mado_catalog_test_[a-f0-9]{12}$/.test(database))
          throw Error('Unsafe database cleanup');
        await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
        await admin.end();
      }
    });
    const styleValues = {
      name: 'Test studio braids',
      slug: 'test-studio-braids',
      categoryId: 1,
      durationMin: 240,
      priceOnConsultation: true,
      active: true,
      featured: true,
      fromPrice: '180',
      sort: 0,
    };
    it('uploads one photo to both placements and preserves placement through replacement', async () => {
      const image = await sharp({
        create: { width: 32, height: 32, channels: 3, background: '#663399' },
      })
        .png()
        .toBuffer();
      const upload = await agent
        .post('/admin/gallery/upload')
        .set('x-csrf-token', token)
        .set('Accept', 'application/json')
        .field('_csrf', token)
        .field('placementFields', '1')
        .field('showOnStyle', 'on')
        .field('showInWork', 'on')
        .field('styleId', '1')
        .field('alt', 'Shared braid photo')
        .field('returnTo', 'gallery')
        .attach('photo', image, 'shared.png')
        .expect(200);
      const id = Number(upload.body.url.split('#photo-')[1]);
      const catalog = await createCatalogService(db).load();
      expect(
        catalog.styles.find((s) => s.id === 1).photos.some((p) => p.id === id),
      ).toBe(true);
      expect(catalog.gallery.some((p) => p.id === id)).toBe(true);
      const before = await service.media(id);
      await agent
        .post('/admin/gallery/' + id + '/replace')
        .set('x-csrf-token', token)
        .set('Accept', 'application/json')
        .field('_csrf', token)
        .attach('photo', image, 'replacement.png')
        .expect(200);
      expect((await service.media(id)).variants.showInWork).toBe(true);
      await agent
        .post('/admin/gallery/' + id)
        .set('Accept', 'application/json')
        .send({
          _csrf: token,
          placementFields: '1',
          showOnStyle: true,
          styleId: '1',
          alt: 'Style only braid photo',
          sort: 0,
        })
        .expect(200);
      const after = await service.media(id);
      expect(after.variants.showInWork).toBe(false);
      expect(after.variants.sizes.length).toBe(before.variants.sizes.length);
      expect(
        (await createCatalogService(db).load()).gallery.some(
          (p) => p.id === id,
        ),
      ).toBe(false);
      await service.removeMedia(id, actor);
    });
    it('saves owner search wording and verification, and rejects scripts', async () => {
      const page = await agent.get('/admin/seo').expect(200);
      expect(page.text).toContain('Search &amp; AI');
      const save = (values) =>
        agent
          .post('/admin/seo')
          .set('Accept', 'application/json')
          .send({ _csrf: token, ...values });
      await save({
        'title:/styles': 'Test braid prices',
        google: '<meta name="google-site-verification" content="test-code_1">',
      }).expect(200);
      const styles = await request(app).get('/styles').expect(200);
      expect(styles.text).toContain('<title>Test braid prices</title>');
      const home = await request(app).get('/').expect(200);
      expect(home.text).toContain('content="test-code_1"');
      const bad = await save({ other: '<script>alert(1)</script>' });
      expect(bad.status).toBe(400);
      expect(bad.body.message).toContain('verification tag');
      const kept = await request(app).get('/styles');
      expect(kept.text).toContain('Test braid prices');
      await save({}).expect(200);
      const reset = await request(app).get('/styles');
      expect(reset.text).toContain('Braiding styles &amp; prices');
    });
    it('reviews a Zelle payment from the booking page and confirms the client', async () => {
      const hold = await bookings.createHold(validHold);
      const proof = await bookings.submitPaymentProof(hold.id, {
        method: 'zelle',
        path: 'payment-' + 'a'.repeat(48) + '.webp',
      });
      const templates = async () =>
        (await db.select().from(s.jobs))
          .map((j) =>
            typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload,
          )
          .filter((p) => p.bookingId === hold.id)
          .map((p) => p.template);
      expect(await templates()).toContain('payment-submitted');
      const detail = await agent.get('/admin/bookings/' + hold.id).expect(200);
      for (const text of [
        'Verify $30 by Zelle',
        '/admin/payment-reviews/' + proof.id + '/image',
        '<dt>Payment source</dt><dd>Zelle</dd>',
        '<dt>Booked through</dt><dd>Website</dd>',
        '$30 Zelle awaiting verification',
      ])
        expect(detail.text).toContain(text);
      const list = await agent.get('/admin/bookings').expect(200);
      expect(list.text).toContain(
        '/admin/bookings/' + hold.id + '#payment-review',
      );
      const result = await agent
        .post('/admin/payment-reviews/' + proof.id)
        .set('Accept', 'application/json')
        .send({ _csrf: token, decision: 'approve', from: 'booking' })
        .expect(200);
      expect(result.body).toEqual({
        url: '/admin/bookings/' + hold.id,
        message: 'Payment approved.',
      });
      expect(await templates()).toContain('booking-confirmation');
      const after = await agent.get('/admin/bookings/' + hold.id).expect(200);
      expect(after.text).not.toContain('id="payment-review"');
      expect(after.text).toContain('<dt>Payment source</dt><dd>Zelle</dd>');
      const [row] = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.id, hold.id));
      expect(row).toMatchObject({ status: 'confirmed', paidCents: 3000 });
    });
    it('sorts and counts appointment tabs, finds clients and their visits', async () => {
      const later = { ...validHold, startAt: '2026-12-29T15:00:00.000Z' };
      const { id } = await bookings.createHold(later);
      for (const view of [
        'today',
        'upcoming',
        'review',
        'balance',
        'past',
        'cancelled',
        'all',
      ])
        await agent.get('/admin/bookings?view=' + view).expect(200);
      expect((await agent.get('/admin/bookings')).text).toMatch(/1–\d+ of \d+/);
      const digits = validHold.phone.replace(/\D/g, '').slice(-7);
      for (const q of [validHold.name.slice(0, 3).toLowerCase(), digits]) {
        const { body } = await agent
          .get('/admin/api/clients')
          .query({ q })
          .expect(200);
        expect(body.clients[0].name).toBe(validHold.name);
      }
      await db
        .update(s.bookings)
        .set({
          status: 'completed',
          startAt: new Date('2025-01-05T15:00:00Z'),
          endAt: new Date('2025-01-05T19:00:00Z'),
          blockEndAt: new Date('2025-01-05T19:00:00Z'),
        })
        .where(eq(s.bookings.id, id));
      const next = await bookings.createHold(later);
      const all = (await agent.get('/admin/bookings?view=all')).text;
      expect(all.indexOf(`/admin/bookings/${next.id}`)).toBeLessThan(
        all.indexOf(`/admin/bookings/${id}"`),
      );
      const detail = (await agent.get('/admin/bookings/' + next.id).expect(200))
        .text;
      expect(detail).toContain('1 completed visit<');
      expect(detail).toContain(`href="/admin/bookings/${id}"`);
      await db
        .update(s.bookings)
        .set({ status: 'cancelled' })
        .where(eq(s.bookings.id, next.id));
    });
    it('shows the owner header, footer, live search and client phone', async () => {
      await bookings.createHold(validHold);
      for (const path of ['/admin', '/admin/bookings']) {
        const { text } = await agent.get(path).expect(200);
        expect(text).toContain('Developed and powered by');
        expect(text).toContain('All rights reserved');
        expect(text).toContain('class="owner-account"');
        expect(text).toContain(
          'class="owner-phone" href="tel:+14437434979">(443) 743-4979</a>',
        );
      }
      const { text } = await agent.get('/admin');
      expect(text).toContain('data-live-filter');
      expect(text).toContain('data-live="appointments"');
      for (const path of ['/admin/balances', '/admin/payment-reviews'])
        expect((await agent.get(path).expect(200)).text).toContain(
          'data-live=',
        );
      const login = await request(app).get('/admin/login').expect(200);
      expect(login.text).not.toContain('owner-footer');
    });
    it('creates a published style and its first priced size and length in one save', async () => {
      const response = await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .send({
          ...styleValues,
          slug: 'one-save-priced-style',
          name: 'One save priced style',
          priceOnConsultation: false,
          durationHours: '4',
          initialPrice: '160.50',
          initialSize: 'medium',
          initialLength: 'shoulder',
          _csrf: token,
        })
        .expect(200);
      const id = Number(response.body.url.split('/').at(-1));
      const catalog = await createCatalogService(db).load();
      const style = catalog.styles.find((item) => item.id === id);
      expect(style.priceOnConsultation).toBe(false);
      expect(style.variants).toHaveLength(1);
      expect(style.variants[0]).toMatchObject({
        priceCents: 16050,
        size: 'medium',
        length: 'shoulder',
        active: true,
      });
      expect(
        (await repository.catalog()).styles.find((item) => item.id === id)
          .variants[0].priceCents,
      ).toBe(16050);
      await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .send({
          ...styleValues,
          slug: 'bad-first-price',
          priceOnConsultation: false,
          initialPrice: '-1',
          _csrf: token,
        })
        .expect(400);
      expect(
        (await service.all()).styles.some(
          (item) => item.slug === 'bad-first-price',
        ),
      ).toBe(false);
    });
    it('saves a whole price grid at once and never leaves a published style without a price', async () => {
      const send = (body) =>
        agent
          .post('/admin/styles/save')
          .set('Accept', 'application/json')
          .send({
            ...styleValues,
            slug: undefined,
            name: 'Grid style',
            priceOnConsultation: 'false',
            durationMin: '240',
            _csrf: token,
            ...body,
          });
      const grid = (rows) => JSON.stringify(rows);
      const refused = (response) =>
        expect([400, 409]).toContain(response.status);
      await send({ prices: '[]' }).expect(refused);
      const made = await send({
        prices: grid([
          {
            size: 'small',
            length: 'waist',
            price: '300',
            active: true,
            durationMin: '360',
          },
          { size: 'medium', length: 'waist', price: '200', active: true },
          { size: 'medium', length: 'shoulder', price: '', active: false },
        ]),
      }).expect(200);
      const id = Number(made.body.url.split('/').at(-1));
      const load = async () =>
        (await service.all()).variants.filter((v) => v.styleId === id);
      let rows = await load();
      expect(
        rows.map((v) => [v.size, v.length, v.priceCents, v.durationMin]),
      ).toEqual([
        ['medium', 'waist', 20000, null],
        ['small', 'waist', 30000, 360],
      ]);
      const [medium, small] = rows;
      await send({
        id,
        prices: grid([
          { id: medium.id, price: '210.50', active: true, durationMin: '' },
          { id: small.id, price: '', active: false, durationMin: '360' },
        ]),
      }).expect(200);
      rows = await load();
      expect(rows[0].priceCents).toBe(21050);
      // Cleared prices are switched off, not lost.
      expect(rows[1]).toMatchObject({ priceCents: 30000, active: false });
      const history = await service.priceHistory(id);
      expect(history[0].switched || history[1].switched).toBe('switched off');
      expect(history.some((h) => h.from === 20000 && h.to === 21050)).toBe(
        true,
      );

      // Every way of removing the last price is refused and rolled back.
      await send({
        id,
        prices: grid([{ id: medium.id, price: '210.50', active: false }]),
      }).expect(refused);
      await expect(
        service.saveVariant(
          id,
          medium.id,
          {
            size: 'medium',
            length: 'waist',
            price: '210.50',
            durationMin: '',
            active: false,
          },
          actor,
        ),
      ).rejects.toThrow('at least one price');
      expect((await load())[0].active).toBe(true);
      // Another style's price cannot be changed through this one.
      await send({
        id,
        prices: grid([{ id: 101, price: '1', active: true }]),
      }).expect(refused);
      await send({ id, prices: 'not json' }).expect(refused);
      await send({
        id,
        prices: grid([{ id: medium.id, price: '-4', active: true }]),
      }).expect(refused);
      expect((await load())[0].priceCents).toBe(21050);

      // Hiding first is fine; publishing again without a price is not.
      const flags = (body) =>
        agent
          .post(`/admin/styles/${id}/flags`)
          .set('Accept', 'application/json')
          .send({ ...body, _csrf: token });
      await flags({ active: false }).expect(200);
      await send({
        id,
        active: undefined,
        prices: grid([{ id: medium.id, price: '210.50', active: false }]),
      }).expect(200);
      await flags({ active: true }).expect(refused);
      await flags({}).expect(refused);
      await flags({ featured: 'yes' }).expect(refused);
    });
    it('deletes a style nobody booked, keeps its photos hidden, and never one with bookings', async () => {
      const copyId = await service.duplicateStyle(1, actor);
      await service.reorderStyles?.([copyId], actor).catch(() => {});
      const [{ id: photoId }] = await db
        .insert(s.media)
        .values({
          styleId: copyId,
          path: 'delete-test.webp',
          alt: 'Copy photo',
          kind: 'style',
          variants: { size: 'small' },
        })
        .$returningId();
      const url = `/admin/styles/${copyId}/delete`;
      const send = (path, id = copyId) =>
        agent
          .post(path.replace(String(copyId), String(id)))
          .set('Accept', 'application/json')
          .send({ _csrf: token });
      await request(app).post(url).expect(403);
      await send(url).expect(200);
      expect(
        await db.select().from(s.styles).where(eq(s.styles.id, copyId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(s.styleVariants)
          .where(eq(s.styleVariants.styleId, copyId)),
      ).toEqual([]);
      const [photo] = await db
        .select()
        .from(s.media)
        .where(eq(s.media.id, photoId));
      expect(photo.styleId).toBe(null);
      const variants =
        typeof photo.variants === 'string'
          ? JSON.parse(photo.variants)
          : photo.variants;
      expect(variants).toEqual({ hidden: true });
      await db.delete(s.media).where(eq(s.media.id, photoId));
      await agent.get('/admin/styles').expect(200);
      await agent.get('/admin/gallery').expect(200);
      const hold = await bookings.createHold({
        ...validHold,
        startAt: '2026-12-21T15:00:00Z',
        email: 'delete-style@example.test',
      });
      const refused = await send(url, validHold.styleId);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toContain('cannot be deleted');
      const [row] = await db
        .select()
        .from(s.bookings)
        .where(eq(s.bookings.id, hold.id));
      await db.delete(s.bookings).where(eq(s.bookings.id, hold.id));
      await db.delete(s.clients).where(eq(s.clients.id, row.clientId));
    });
    it('orders, duplicates and groups styles without moving anything until asked', async () => {
      const before = (await service.all()).styles.map((x) => x.id);
      await expect(
        service.reorderStyles(before.slice(1), actor),
      ).rejects.toThrow('Refresh');
      const wanted = [...before].reverse();
      await service.reorderStyles(wanted, actor);
      expect((await service.all()).styles.map((x) => x.id)).toEqual(wanted);
      const shown = (await createCatalogService(db).load()).styles.map(
        (x) => x.id,
      );
      expect(shown).toEqual(wanted.filter((id) => shown.includes(id)));

      const copyId = await service.duplicateStyle(1, actor);
      const data = await service.all();
      expect(data.styles[0]).toMatchObject({
        id: copyId,
        active: false,
        featured: false,
      });
      expect(data.variants.filter((v) => v.styleId === copyId).length).toBe(
        data.variants.filter((v) => v.styleId === 1).length,
      );
      expect(
        (await request(app).get('/styles/' + data.styles[0].slug)).status,
      ).toBe(404);

      const category = await service.saveCategory(null, 'Kids styles', actor);
      const find = async () =>
        (await service.all()).categories.find((c) => c.id === category);
      expect((await find()).slug).toBe('kids-styles');
      await service.saveCategory(category, 'Children', actor);
      expect(await find()).toMatchObject({
        name: 'Children',
        slug: 'kids-styles',
      });
      await expect(
        service.saveCategory(null, 'children', actor),
      ).rejects.toThrow('already exists');
      // An empty category is not offered to clients.
      expect((await request(app).get('/styles')).text).not.toContain(
        'category=kids-styles',
      );
      await service.removeCategory(category, actor);
      await expect(
        service.removeCategory(
          data.styles.find((x) => x.id === 1).categoryId,
          actor,
        ),
      ).rejects.toThrow('Move its styles');
      // Leave the later tests with the default order.
      await db.delete(s.settings).where(eq(s.settings.key, 'catalog'));
    });
    it('keeps the website name of an extra, creates one automatically, and switches and orders extras', async () => {
      const save = (body) =>
        agent
          .post('/admin/addons')
          .set('Accept', 'application/json')
          .send({
            price: '40',
            durationMin: '15',
            description: '',
            active: 'on',
            appliesToAll: 'true',
            _csrf: token,
            ...body,
          });
      const original = (await service.all()).addons[0];
      await save({
        id: original.id,
        name: 'Renamed extra',
        slug: 'hacked',
      }).expect(200);
      let extras = (await service.all()).addons;
      expect(extras.find((a) => a.id === original.id)).toMatchObject({
        slug: original.slug,
        name: 'Renamed extra',
      });
      await save({ name: 'Gold beads' }).expect(200);
      await save({ name: 'Gold beads' }).expect(200);
      extras = (await service.all()).addons;
      expect(extras.slice(-2).map((a) => a.slug)).toEqual([
        'gold-beads',
        'gold-beads-2',
      ]);
      await save({ name: 'None chosen', appliesToAll: 'false' }).expect((r) =>
        expect([400, 409]).toContain(r.status),
      );
      const ids = extras.map((a) => a.id).reverse();
      await service.reorderAddons(ids, actor);
      expect((await service.all()).addons.map((a) => a.id)).toEqual(ids);
      await service.setAddonActive(ids[0], false, actor);
      expect(
        (await createCatalogService(db).load()).addons.some(
          (a) => a.id === ids[0],
        ),
      ).toBe(false);
      await service.reorderAddons(
        extras.map((a) => a.id),
        actor,
      );
      await service.saveAddon(
        original.id,
        {
          ...original,
          price: (original.priceCents / 100).toFixed(2),
          description: original.description || '',
        },
        actor,
      );
      for (const extra of extras.slice(-2))
        await db.delete(s.addons).where(eq(s.addons.id, extra.id));
    });
    it('reorders the photos of one style without moving the rest of the library', async () => {
      const add = (styleId, kind, sort) =>
        service.saveMedia(
          null,
          {
            path: '/img/styles/x.webp',
            alt: 'Order photo',
            kind,
            styleId,
            sort,
          },
          actor,
        );
      const a = await add(1, 'style', 500);
      const other = await add(null, 'gallery', 501);
      const b = await add(1, 'style', 502);
      const own = async () =>
        (await service.all()).media
          .filter((m) => m.styleId === 1 && m.kind === 'style')
          .map((m) => m.id);
      const ids = await own();
      const swapped = ids.map((id) => (id === a ? b : id === b ? a : id));
      await service.reorderStylePhotos(1, swapped, actor);
      expect(await own()).toEqual(swapped);
      const order = (await service.all()).media.map((m) => m.id);
      expect(order.indexOf(other)).toBeGreaterThan(order.indexOf(b));
      expect(order.indexOf(other)).toBeLessThan(order.indexOf(a));
      await expect(
        service.reorderStylePhotos(1, [other], actor),
      ).rejects.toThrow('Refresh');
      for (const id of [a, b, other]) await service.removeMedia(id, actor);
    });
    it('places, hides, removes and restores photos without changing what clients already see', async () => {
      const add = (styleId, kind, variants) =>
        service.saveMedia(
          null,
          {
            path: '/img/styles/' + randomUUID() + '.webp',
            alt: 'Library photo',
            kind,
            styleId,
            sort: 0,
            ...(variants ? { variants } : {}),
          },
          actor,
        );
      const styleId = await service.saveStyle(
        null,
        {
          ...styleValues,
          name: 'Library style',
          slug: 'library-style',
          priceOnConsultation: true,
          active: true,
        },
        actor,
      );
      const cover = await add(styleId, 'style');
      const post = (url, body) =>
        agent
          .post('/admin/gallery/' + url)
          .set('Accept', 'application/json')
          .send({ ...body, _csrf: token });
      const refused = (r) => expect([400, 404, 409]).toContain(r.status);
      const row = (id) => service.media(id);
      const shown = async (id) => {
        const text = (await request(app).get('/our-work')).text;
        return text.includes((await row(id)).path);
      };
      const details = (id, body) =>
        post(id + '/details', {
          alt: 'A clear description',
          focus: { x: 50, y: 50 },
          ...body,
        });
      // A style cover shows on Our Work by default, and saving keeps it there.
      expect(await shown(cover)).toBe(true);
      expect((await agent.get('/admin/gallery')).text).toMatch(
        new RegExp(`id="photo-${cover}"[^>]*data-in-work="yes"`),
      );
      await details(cover, { focus: { x: 22, y: 81 } }).expect(200);
      expect(await shown(cover)).toBe(true);
      expect((await row(cover)).variants.focus).toEqual({ x: 20, y: 80 });
      expect((await request(app).get('/styles/library-style')).text).toContain(
        'has-focus fx-20 fy-80',
      );
      await post('place', { ids: [cover], showInWork: false }).expect(200);
      expect(await shown(cover)).toBe(false);
      expect((await row(cover)).kind).toBe('style');

      // Hidden photos leave every page but stay in the library.
      await details(cover, { showOnStyle: false, showInWork: false }).expect(
        200,
      );
      expect((await row(cover)).variants.hidden).toBe(true);
      const path = (await row(cover)).path;
      for (const url of ['/our-work', '/styles/library-style', '/styles'])
        expect((await request(app).get(url)).text).not.toContain(path);
      await details(cover, { showOnStyle: true, showInWork: false }).expect(
        200,
      );
      expect((await request(app).get('/styles/library-style')).text).toContain(
        path,
      );

      // Portfolio photos need a style before a style page can show them.
      const loose = await add(null, 'gallery');
      await post('place', { ids: [loose], showOnStyle: true }).expect(refused);
      await post('place', { ids: [loose, cover], styleId }).expect(200);
      expect((await row(loose)).styleId).toBe(styleId);
      expect(await shown(loose)).toBe(true);
      await post('place', { ids: [loose, 999999], showInWork: false }).expect(
        refused,
      );
      expect(await shown(loose)).toBe(true);
      await post('place', { ids: [loose] }).expect(refused);
      await details(loose, { alt: 'x' }).expect(refused);
      await details(loose, { styleId: 999999 }).expect(refused);

      // Removing can be undone for a week.
      await post('trash', { ids: [loose, cover] }).expect(200);
      expect((await service.all()).media.some((m) => m.id === loose)).toBe(
        false,
      );
      expect((await request(app).get('/our-work')).text).not.toContain(path);
      await details(loose, {}).expect(refused);
      await post('restore', { ids: [loose, cover] }).expect(200);
      expect(await shown(loose)).toBe(true);
      await post('restore', { ids: [loose] }).expect(refused);
      await post('trash', { ids: [loose] }).expect(200);
      expect(await service.purgeRemovedMedia()).toBe(0);
      const later = createManagementService(db, () =>
        now.plus({ days: 8 }).toJSDate(),
      );
      expect(await later.purgeRemovedMedia()).toBe(1);
      await expect(service.media(loose)).rejects.toThrow('not found');

      // A rotated reference photo is still a reference; a new photo is not.
      const reference = await add(styleId, 'style', { origin: 'generated' });
      await db
        .update(s.media)
        .set({ alt: 'AI hairstyle reference: long locs' })
        .where(eq(s.media.id, reference));
      const image = {
        path: '/img/styles/new.webp',
        width: 10,
        height: 10,
        variants: { origin: 'supplied', sizes: [] },
      };
      await service.replaceMediaImage(reference, image, actor, true);
      expect(await row(reference)).toMatchObject({
        alt: 'AI hairstyle reference: long locs',
        variants: { origin: 'generated' },
      });
      await service.replaceMediaImage(reference, image, actor);
      expect(await row(reference)).toMatchObject({
        alt: 'long locs',
        variants: { origin: 'supplied' },
      });
      for (const id of [cover, reference]) await service.removeMedia(id, actor);
      await service.setStyleFlags(styleId, { active: false }, actor);
    });
    it('saves the Our Work order, and manages video switches, covers and removal', async () => {
      const post = (url, body) =>
        agent
          .post('/admin/gallery/' + url)
          .set('Accept', 'application/json')
          .send({ ...body, _csrf: token });
      const refused = (r) => expect([400, 404, 409]).toContain(r.status);
      const films = async () =>
        [
          ...(await request(app).get('/our-work')).text.matchAll(
            /id="film-([a-z0-9-]+)"/g,
          ),
        ].map((m) => m[1]);
      const before = await films();
      const wanted = [...before].reverse();
      await post('work-order', {
        order: wanted.map((id) => 'film:' + id),
      }).expect(200);
      expect(await films()).toEqual(wanted);
      await post('work-order', { order: ['film:a', 'film:a'] }).expect(refused);
      await post('work-order', { order: ['<script>'] }).expect(refused);
      await db.delete(s.settings).where(eq(s.settings.key, 'ourWork'));

      const id = before[0];
      await post(`videos/${id}/flags`, { showInWork: false }).expect(200);
      expect(await films()).not.toContain(id);
      expect(
        (await service.all()).videos.find((v) => v.id === id).enabled,
      ).toBe(true);
      await post(`videos/${id}/flags`, { showInWork: true }).expect(200);
      expect(await films()).toContain(id);
      await post(`videos/${id}/flags`, {}).expect(refused);
      await post(`videos/${id}/remove`, {}).expect(refused);
      const cover = {
        path: '/media/catalog/cover.webp',
        variants: { sizes: [] },
      };
      await service.setVideoCover(id, cover, actor);
      expect((await request(app).get('/our-work')).text).toContain(
        'poster="/media/catalog/cover.webp"',
      );
      const own = await service.saveVideo(
        null,
        {
          title: 'Mine',
          description: 'My own clip',
          enabled: true,
          showInWork: true,
        },
        { src: '/media/videos/x.mp4', poster: '/media/catalog/x.webp' },
        actor,
      );
      expect(await films()).toContain(own.id);
      await post(`videos/${own.id}/remove`, {}).expect(200);
      expect(await films()).not.toContain(own.id);
      await post(`videos/${own.id}/remove`, {}).expect(refused);
    });
    it('treats records as one person, and edits, joins, unsubscribes and removes them safely', async () => {
      const people = service.people;
      const refused = (r) => expect([400, 403, 404, 409]).toContain(r.status);
      const post = (url, body) =>
        agent
          .post('/admin/clients/' + url)
          .set('Accept', 'application/json')
          .send({ ...body, _csrf: token });
      const page = async (url) => (await agent.get(url).expect(200)).text;
      const start = (n) =>
        now
          .plus({ days: 40 + n })
          .set({ hour: 15, minute: 0, second: 0, millisecond: 0 })
          .toISO();
      const book = (n, values) =>
        bookings.createHold(
          { ...validHold, startAt: start(n), ...values },
          null,
          { admin: actor, mode: 'override' },
        );
      const one = {
        name: 'Zuri Cole',
        email: 'zuri@x.test',
        phone: '+14437434101',
      };
      const a = await book(0, one);
      const b = await book(1, { ...one, email: 'ZURI@x.test' });
      const c = await book(2, {
        name: 'Other Cole',
        email: 'other@x.test',
        phone: one.phone,
      });
      const rowOf = async (id) =>
        (await db.select().from(s.bookings).where(eq(s.bookings.id, id)))[0];
      const [idA, idB, idC] = [
        (await rowOf(a.id)).clientId,
        (await rowOf(b.id)).clientId,
        (await rowOf(c.id)).clientId,
      ];
      const clientRow = async (id) =>
        (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0];

      const list = await page('/admin/clients?search=zuri');
      expect(list.match(/class="client-row"/g)).toHaveLength(1);
      expect(list).toContain('Repeat');
      expect(list).toContain('Possible match');
      expect(list).toMatch(/1–1 of 1/);
      const text = await page('/admin/clients/' + idA);
      expect(text).toContain('Is this the same person?');
      expect(text).toContain('/admin/bookings/new?client=' + idA);
      // Any of their records opens the same profile.
      await agent
        .get('/admin/clients/' + idB)
        .expect(303)
        .expect('Location', '/admin/clients/' + idA);
      expect(await page('/admin/bookings/new?client=' + idB)).toContain(
        'value="Zuri Cole"',
      );
      await agent.get('/admin/clients/999999').expect(refused);

      // Notes and tags belong to the person and show on each appointment.
      await post(idA + '/notes', {
        notes: 'Likes the window',
        tags: '["Allergy","VIP"]',
      }).expect(200);
      for (const id of [a.id, b.id]) {
        const detail = await page('/admin/bookings/' + id);
        expect(detail).toContain('Likes the window');
        expect(detail).toContain('Allergy');
      }
      expect(await page('/admin/bookings/' + c.id)).not.toContain(
        'Likes the window',
      );
      await post(idA + '/notes', { notes: '', tags: 'bad' }).expect(refused);
      await post(idA + '/notes', {
        notes: '',
        tags: JSON.stringify(['x'.repeat(40)]),
      }).expect(refused);

      // Editing covers every record; a taken email is refused.
      await post(idA + '/details', {
        name: 'Zuri Cole-Adams',
        email: 'other@x.test',
        phone: one.phone,
      }).expect(refused);
      await post(idA + '/details', {
        name: 'Zuri Cole-Adams',
        email: 'nope',
        phone: one.phone,
      }).expect(refused);
      await post(idA + '/details', {
        name: 'Zuri Cole-Adams',
        email: 'zuri.new@x.test',
        phone: '+14437434102',
      }).expect(200);
      for (const id of [idA, idB])
        expect(await clientRow(id)).toMatchObject({
          name: 'Zuri Cole-Adams',
          email: 'zuri.new@x.test',
          phoneE164: '+14437434102',
        });
      expect((await clientRow(idC)).name).toBe('Other Cole');
      expect(await page('/admin/clients/' + idA)).toContain(
        'zuri@x.test → zuri.new@x.test'.replace('zuri@x.test', 'ZURI@x.test'),
      );

      // Join, undo and keep apart.
      await post(idA + '/join', { other: idC }).expect(200);
      expect((await people.summary(idC)).ids).toEqual([idA, idB, idC]);
      await post(idA + '/join', { other: idC }).expect(refused);
      await post(idA + '/unjoin', { pair: `${idA}-${idC}` }).expect(200);
      expect((await people.summary(idC)).ids).toEqual([idC]);
      await post(idA + '/unjoin', { pair: `${idA}-${idC}` }).expect(refused);
      await post(idA + '/details', {
        name: 'Zuri Cole-Adams',
        email: 'zuri.new@x.test',
        phone: one.phone,
      }).expect(200);
      expect((await people.profile(idA)).matches).toHaveLength(1);
      await post(idA + '/apart', { other: idC }).expect(200);
      expect((await people.profile(idA)).matches).toHaveLength(0);

      // Stopping news covers every record and waiting message.
      await db
        .update(s.clients)
        .set({ marketingConsent: true, consentAt: new Date('2026-01-01') })
        .where(eq(s.clients.id, idB));
      await db.insert(s.jobs).values({
        type: 'winback',
        payload: { clientId: idB, bookingId: b.id },
        dedupeKey: 'person-winback',
        runAt: new Date(),
        status: 'pending',
      });
      await post(idA + '/stop-news', {}).expect(200);
      expect(await clientRow(idB)).toMatchObject({ marketingConsent: false });
      const job = async (key) =>
        (await db.select().from(s.jobs).where(eq(s.jobs.dedupeKey, key)))[0];
      expect((await job('person-winback')).status).toBe('cancelled');
      // A new booking on a new record cancels an old come-back message too.
      await db
        .update(s.jobs)
        .set({ status: 'pending' })
        .where(eq(s.jobs.dedupeKey, 'person-winback'));
      const d = await book(3, {
        name: 'Zuri Cole-Adams',
        email: 'Zuri.New@x.test',
        phone: one.phone,
      });
      expect((await job('person-winback')).status).toBe('cancelled');

      // Removal waits for upcoming visits and balances.
      await post(idA + '/remove', { confirm: 'remove' }).expect(refused);
      await post(idA + '/remove', { confirm: 'REMOVE' }).expect(refused);
      expect((await clientRow(idA)).name).toBe('Zuri Cole-Adams');
      const mine = [a.id, b.id, d.id];
      const finish = (values) =>
        Promise.all(
          mine.map((id) =>
            db.update(s.bookings).set(values).where(eq(s.bookings.id, id)),
          ),
        );
      await finish({
        status: 'completed',
        startAt: new Date('2026-01-05T15:00:00Z'),
        endAt: new Date('2026-01-05T19:00:00Z'),
        blockEndAt: new Date('2026-01-05T19:00:00Z'),
        clientNotes: 'Private words about Zuri',
        adminNotes: 'Owner words',
      });
      await post(idA + '/remove', { confirm: 'REMOVE' }).expect(refused);
      await finish({ balanceCents: 0, paidCents: 18000 });
      const [photo] = await db
        .insert(s.media)
        .values({
          kind: 'inspiration',
          path: 'private.webp',
          alt: 'x',
          sort: 0,
        })
        .$returningId();
      await db
        .update(s.bookings)
        .set({ inspirationMediaId: photo.id })
        .where(eq(s.bookings.id, a.id));
      await db.insert(s.paymentProofs).values({
        bookingId: a.id,
        method: 'zelle',
        paymentType: 'deposit',
        amountCents: 3000,
        path: 'payment-x.webp',
        status: 'approved',
      });
      await db.insert(s.emailLog).values({
        bookingId: a.id,
        clientId: idA,
        template: 'booking-confirmation',
        toEmail: 'zuri.new@x.test',
        status: 'sent',
      });
      await db.insert(s.notifications).values({
        type: 'x',
        title: 'Zuri booked',
        body: 'x',
        url: '/admin/bookings/' + a.id,
      });
      await db.insert(s.jobs).values({
        type: 'email',
        payload: {
          template: 'contact-enquiry',
          body: 'From zuri.new@x.test',
        },
        dedupeKey: 'person-contact',
        runAt: new Date(),
        status: 'done',
      });
      await post(idA + '/remove', { confirm: 'REMOVE' }).expect(200);
      for (const id of [idA, idB])
        expect(await clientRow(id)).toMatchObject({
          name: 'Removed client',
          phoneE164: '',
          notes: null,
          marketingConsent: false,
        });
      expect(await rowOf(a.id)).toMatchObject({
        status: 'completed',
        paidCents: 18000,
        clientNotes: null,
        adminNotes: null,
        inspirationMediaId: null,
      });
      expect(
        (await db.select().from(s.media).where(eq(s.media.id, photo.id)))
          .length,
      ).toBe(0);
      const everything = JSON.stringify([
        await db.select().from(s.clients),
        await db.select().from(s.bookings),
        await db.select().from(s.auditLog),
        await db.select().from(s.emailLog),
        await db.select().from(s.notifications),
        await db.select().from(s.jobs),
        await db.select().from(s.paymentProofs),
        await db.select().from(s.settings),
      ]);
      for (const trace of [
        'Zuri',
        'zuri',
        'Private words',
        'Owner words',
        'Likes the window',
        'payment-x.webp',
        '14437434102',
      ])
        expect(everything.includes(trace), trace).toBe(false);
      // Their family member is untouched, and the records still open.
      expect(await clientRow(idC)).toMatchObject({
        name: 'Other Cole',
        phoneE164: one.phone,
      });
      expect(await page('/admin/bookings/' + a.id)).toContain('Removed client');
      expect(await page('/admin/clients/' + idA)).toContain(
        'Personal details were removed',
      );
      expect(await page('/admin/clients')).not.toContain('Removed client');
      expect(
        (await agent.get('/admin/api/clients').query({ q: 'removed' })).body
          .clients,
      ).toEqual([]);
      for (const path of ['/notes', '/details', '/stop-news', '/remove'])
        await post(idA + path, {
          ...one,
          notes: 'x',
          tags: '[]',
          confirm: 'REMOVE',
        }).expect(refused);
      await db
        .update(s.bookings)
        .set({ status: 'cancelled' })
        .where(eq(s.bookings.id, c.id));
    });
    it('exports clients safely and needs a signed-in owner', async () => {
      const held = await bookings.createHold(
        {
          ...validHold,
          name: '=HYPERLINK("x")',
          email: 'csv@x.test',
          phone: '+14437434199',
          startAt: now.plus({ days: 50 }).set({ hour: 16, minute: 0 }).toISO(),
        },
        null,
        { admin: actor, mode: 'override' },
      );
      const csv = await agent
        .get('/admin/clients/export?search=csv')
        .expect(200);
      expect(csv.headers['content-type']).toMatch(/csv/);
      expect(csv.text).toContain(`"'=HYPERLINK`);
      for (const url of [
        '/admin/clients',
        '/admin/clients/1',
        '/admin/clients/export',
      ])
        expect([303, 401]).toContain((await request(app).get(url)).status);
      await agent.get('/admin/clients?view=nonsense').expect(400);
      await db
        .update(s.bookings)
        .set({ status: 'cancelled' })
        .where(eq(s.bookings.id, held.id));
    });
    it('creates a style with its cover photo in one save', async () => {
      const image = await sharp({
        create: { width: 700, height: 900, channels: 3, background: '#73489a' },
      })
        .jpeg()
        .toBuffer();
      const made = await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .field({
          name: 'Photo first style',
          categoryId: String(styleValues.categoryId),
          durationMin: '240',
          active: 'on',
          priceOnConsultation: 'false',
          prices: JSON.stringify([
            { size: '', length: '', price: '90', active: true },
          ]),
        })
        .attach('photo', image, 'cover.jpg')
        .expect(200);
      const id = Number(made.body.url.split('/').at(-1));
      const style = (await createCatalogService(db).load()).styles.find(
        (x) => x.id === id,
      );
      expect(style.photos).toHaveLength(1);
      expect(style.photos[0].alt).toBe('Photo first style hairstyle');
      expect(style.variants[0].priceCents).toBe(9000);
    });
    it('lists newest styles first without manual ordering and keeps edits in place', async () => {
      const actor = { id: 1, ip: '127.0.0.1' };
      const first = await service.saveStyle(
        null,
        {
          ...styleValues,
          name: 'First automatic style',
          slug: 'first-automatic-style',
          sort: 9999,
        },
        actor,
      );
      const second = await service.saveStyle(
        null,
        {
          ...styleValues,
          name: 'Second automatic style',
          slug: 'second-automatic-style',
          sort: 0,
        },
        actor,
      );
      await db
        .update(s.styles)
        .set({ createdAt: new Date('2026-11-22T12:00:00Z') })
        .where(eq(s.styles.id, first));
      await db
        .update(s.styles)
        .set({ createdAt: new Date('2026-11-22T12:00:00Z') })
        .where(eq(s.styles.id, second));
      await service.saveStyle(
        first,
        {
          ...styleValues,
          name: 'Edited first automatic style',
          slug: 'first-automatic-style',
        },
        actor,
      );
      for (const styles of [
        (await service.all()).styles,
        (await createCatalogService(db).load()).styles,
      ]) {
        const ids = styles
          .filter((style) => [first, second].includes(style.id))
          .map((style) => style.id);
        expect(ids).toEqual([second, first]);
      }
      for (const path of ['/admin/styles/new', '/admin/styles/' + first]) {
        const page = await agent.get(path);
        expect(page.status).toBe(200);
        expect(page.text).not.toContain('Display order');
      }
    });
    it('searches owner records by contact/code and content while excluding private inspiration and literal SQL wildcards', async () => {
      const hold = await bookings.createHold(
        {
          ...validHold,
          name: 'Maya Search',
          email: 'maya.search@example.test',
          phone: '+14437434979',
          startAt: now.plus({ days: 19 }).set({ hour: 15, minute: 0 }).toISO(),
        },
        null,
        { admin: actor, mode: 'override' },
      );
      const search = createAdminRepository(db).searchPortal;
      for (const query of [
        'MAYA.SEARCH@EXAMPLE.TEST',
        '(443) 743-4979',
        hold.ref,
      ]) {
        const groups = await search(query);
        expect(
          groups
            .flatMap((g) => g.items)
            .some((item) => item.href === '/admin/bookings/' + hold.id),
        ).toBe(true);
      }
      const styleId = await service.saveStyle(
        null,
        {
          ...styleValues,
          name: 'Searchworthy Twists',
          slug: undefined,
          active: false,
        },
        actor,
      );
      await service.saveAddon(
        null,
        {
          name: 'Searchworthy Wash',
          slug: 'searchworthy-wash',
          price: '25',
          durationMin: 0,
          active: true,
          appliesToAll: true,
        },
        actor,
      );
      await service.saveMedia(
        null,
        {
          kind: 'style',
          styleId,
          path: '/img/logo.webp',
          alt: 'Searchworthy portfolio photo',
          sort: 0,
        },
        actor,
      );
      await service.saveVideo(
        null,
        {
          title: 'Searchworthy Film',
          description: 'Short braid clip',
          enabled: false,
          showInWork: true,
        },
        { src: '/media/videos/test.mp4', poster: '/img/logo.webp' },
        actor,
      );
      await db.insert(s.media).values({
        kind: 'inspiration',
        path: 'private.webp',
        alt: 'PrivateInspirationOnly',
        sort: 0,
      });
      const groups = await search('Searchworthy');
      expect(groups.map((g) => g.label)).toEqual(
        expect.arrayContaining([
          'Styles & prices',
          'Extras',
          'Photos',
          'Videos',
        ]),
      );
      for (const query of ['PrivateInspirationOnly', '%_', "' OR 1=1 --"])
        expect(await search(query)).toEqual([]);
      const response = await agent
        .get('/admin/api/search?q=Searchworthy')
        .set('Accept', 'application/json')
        .expect(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(
        response.body.groups
          .flatMap((g) => g.items)
          .some((item) => item.href === '/admin/styles/' + styleId),
      ).toBe(true);
    });
    it('generates readable unique page addresses automatically and preserves them on name changes', async () => {
      const values = {
        ...styleValues,
        name: 'Café & Twist Braids',
        slug: undefined,
      };
      const first = await service.saveStyle(null, values, actor);
      const second = await service.saveStyle(null, values, actor);
      const [a] = await db
        .select()
        .from(s.styles)
        .where(eq(s.styles.id, first));
      const [b] = await db
        .select()
        .from(s.styles)
        .where(eq(s.styles.id, second));
      expect(a.slug).toBe('cafe-twist-braids');
      expect(b.slug).toBe('cafe-twist-braids-2');
      await service.saveStyle(
        first,
        { ...values, name: 'A new display name' },
        actor,
      );
      const [updated] = await db
        .select()
        .from(s.styles)
        .where(eq(s.styles.id, first));
      expect(updated.slug).toBe(a.slug);
      await request(app)
        .get('/styles/' + a.slug)
        .expect(200);
    });
    it('renders all new screens for the owner and denies anonymous mutations', async () => {
      for (const path of [
        'styles',
        'styles/new',
        'styles/1',
        'addons',
        'availability',
        'gallery',
        'clients',
        'settings',
        'redirects',
      ]) {
        const page = await agent.get('/admin/' + path);
        expect(page.status, path + ': ' + page.text.slice(-1600)).toBe(200);
      }
      await request(app)
        .post('/admin/styles/save')
        .send(styleValues)
        .expect(403);
      await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .send({ ...styleValues, _csrf: 'bad' })
        .expect(403);
    });
    it('publishes a style to public pages, booking catalog and sitemap immediately, and redirects renamed slugs', async () => {
      const saved = await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .send({ ...styleValues, _csrf: token })
        .expect(200);
      const id = Number(saved.body.url.split('/').at(-1));
      expect((await repository.catalog()).styles.some((r) => r.id === id)).toBe(
        true,
      );
      expect(
        (await request(app).get('/styles/test-studio-braids')).status,
      ).toBe(200);
      expect((await request(app).get('/sitemap.xml')).text).toContain(
        '/styles/test-studio-braids',
      );
      await service.saveStyle(
        id,
        { ...styleValues, slug: 'studio-braids-renamed' },
        actor,
      );
      await request(app)
        .get('/styles/test-studio-braids')
        .expect(301)
        .expect('Location', '/styles/studio-braids-renamed');
      await service.saveStyle(
        id,
        { ...styleValues, active: false, slug: 'studio-braids-renamed' },
        actor,
      );
      expect((await repository.catalog()).styles.some((r) => r.id === id)).toBe(
        false,
      );
      expect((await request(app).get('/sitemap.xml')).text).not.toContain(
        'studio-braids-renamed',
      );
    });
    it('changes future prices without changing the existing booking snapshot or balance', async () => {
      const hold = await bookings.createHold(validHold);
      const before = await repository.bookingById(hold.id);
      await service.saveVariant(
        1,
        101,
        {
          size: 'medium',
          length: 'mid_back',
          label: '',
          price: '225.50',
          durationMin: '',
          active: true,
          sort: 0,
        },
        actor,
      );
      const after = await repository.bookingById(hold.id);
      expect(after.priceSnapshot).toEqual(before.priceSnapshot);
      expect(after.balanceCents).toBe(before.balanceCents);
      expect(
        (await repository.catalog()).styles
          .find((r) => r.id === 1)
          .variants.find((v) => v.id === 101).priceCents,
      ).toBe(22550);
    });
    it('blocks time under the same date locks and rejects a block overlapping a valid hold', async () => {
      await expect(
        service.addBlocks(
          {
            date: '2026-12-03',
            start: '09:00',
            end: '10:00',
            repeat: 'once',
            reason: 'Away',
          },
          actor,
        ),
      ).rejects.toThrow('starts in this time');
      await service.addBlocks(
        {
          date: '2026-12-04',
          start: '09:00',
          end: '10:00',
          repeat: 'once',
          reason: 'Away',
        },
        actor,
      );
      await expect(
        bookings.createHold({ ...validHold, startAt: '2026-12-04T14:00:00Z' }),
      ).rejects.toThrow();
    });
    it('rejects redirect loops and duplicate null-size variants', async () => {
      await service.saveRedirect(
        null,
        { source: '/old-look', target: '/older-look' },
        actor,
      );
      await expect(
        service.saveRedirect(
          null,
          { source: '/older-look', target: '/old-look' },
          actor,
        ),
      ).rejects.toThrow('loop');
      await service.saveVariant(
        1,
        null,
        {
          size: '',
          length: '',
          label: 'Custom',
          price: '200',
          durationMin: '',
          active: true,
          sort: 99,
        },
        actor,
      );
      await expect(
        service.saveVariant(
          1,
          null,
          {
            size: '',
            length: '',
            price: '200',
            durationMin: '',
            active: true,
            sort: 99,
          },
          actor,
        ),
      ).rejects.toThrow('already exists');
    });
    it('records owner changes in audit history', async () => {
      const rows = await db
        .select()
        .from(s.auditLog)
        .where(eq(s.auditLog.adminId, 1));
      expect(rows.length).toBeGreaterThan(5);
    });
    it('applies balance-method settings to the visit and rejects disabled card checkout', async () => {
      const hold = await bookings.createHold({
        ...validHold,
        startAt: '2026-12-06T15:00:00Z',
      });
      await bookings.adminAction(
        hold.id,
        {
          action: 'payment',
          amountCents: 3000,
          method: 'cash',
          note: 'Deposit received',
          requestKey: randomUUID(),
        },
        actor,
      );
      await service.saveSettings(
        {
          balanceOptions: {
            online: false,
            zelle: false,
            cashapp: false,
            cash: true,
            terminal: false,
          },
        },
        actor,
      );
      const visit = await agent.get('/booking/' + hold.manageToken);
      expect(visit.status).toBe(200);
      expect(visit.text).not.toContain('data-balance-form');
      await agent
        .post('/api/bookings/' + hold.ref + '/balance')
        .set('x-csrf-token', token)
        .send({})
        .expect(409);
      expect((await repository.bookingById(hold.id)).paidCents).toBe(3000);
    });
    it('replaces only image bytes while retaining the photo ID, caption, style, order and size', async () => {
      const id = await service.saveMedia(
        null,
        {
          kind: 'style',
          styleId: 1,
          path: '/img/styles/old-photo.webp',
          alt: 'Original caption',
          sort: 17,
          width: 960,
          height: 1200,
          variants: { origin: 'generated', size: 'medium', sizes: [] },
        },
        actor,
      );
      const before = await service.media(id);
      const image = await sharp({
        create: { width: 500, height: 700, channels: 3, background: '#73489a' },
      })
        .png()
        .toBuffer();
      await agent
        .post('/admin/gallery/' + id + '/replace')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .field('alt', 'Do not change this caption')
        .field('styleId', '9999')
        .field('kind', 'gallery')
        .field('sort', '0')
        .attach('photo', image, 'replacement.png')
        .expect(200);
      const after = await service.media(id);
      expect(after).toMatchObject({
        id: before.id,
        kind: before.kind,
        styleId: before.styleId,
        alt: before.alt,
        sort: before.sort,
      });
      expect(after.path).not.toBe(before.path);
      expect(after.path).toMatch(/^\/media\/catalog\//);
      expect(after.variants.size).toBe('medium');
      expect(after.variants.origin).toBe('supplied');
      const invalid = await agent
        .post('/admin/gallery/' + id + '/replace')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .attach('photo', Buffer.from('not an image'), 'bad.png');
      expect(invalid.status).toBe(400);
      expect((await service.media(id)).path).toBe(after.path);
      const audit = await db
        .select()
        .from(s.auditLog)
        .where(eq(s.auditLog.entityId, id));
      expect(
        audit.some((row) => {
          const value =
            typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
          return value?.path === after.path;
        }),
      ).toBe(true);
      await service.removeMedia(id, actor);
      const gallery = await agent.get('/admin/gallery');
      expect(gallery.status).toBe(200);
      expect(gallery.text).toContain('data-missing-style="1"');
      expect(
        (await repository.catalog()).styles.some((style) => style.id === 1),
      ).toBe(true);
    }, 30000);
    it('rejects unauthorized replacement, missing uploads and private inspiration media', async () => {
      const [privatePhoto] = await db
        .insert(s.media)
        .values({
          kind: 'inspiration',
          path: 'private-inspiration.webp',
          alt: 'Private client photo',
        })
        .$returningId();
      const denied = await agent
        .post('/admin/gallery/' + privatePhoto.id + '/replace')
        .set('Accept', 'application/json')
        .set('x-csrf-token', token)
        .attach('photo', Buffer.from('invalid'), 'photo.png');
      expect(denied.status).toBe(400);
      await agent
        .post('/admin/gallery/1/replace')
        .set('Accept', 'application/json')
        .field('returnTo', 'gallery')
        .expect(403);
      expect(
        (
          await db.select().from(s.media).where(eq(s.media.id, privatePhoto.id))
        )[0].path,
      ).toBe('private-inspiration.webp');
    });
    const saveAs = (url, body) =>
      agent
        .post('/admin' + url)
        .set('Accept', 'application/json')
        .send({ ...body, _csrf: token });
    it('saves each settings section without losing the others, and names the box to fix', async () => {
      const before = (await service.all()).settings;
      const business = {
        name: 'Mado African Braidz',
        phone: '443 743 4979',
        street: '1 Main St',
        city: 'Lanham',
        region: 'MD',
        postalCode: '20706',
        instagram: '',
        tiktok: '',
        facebook: '',
        google: '',
      };
      const bad = await saveAs('/settings/business', {
        ...business,
        phone: '12',
        facebook: 'facebook.com/mado',
      });
      expect(bad.status).toBe(400);
      expect(Object.keys(bad.body.fields).sort()).toEqual([
        'facebook',
        'phone',
      ]);
      await saveAs('/settings/business', business).expect(200);
      await saveAs('/settings/payments', {
        deposit: '42.50',
        holdMinutes: '45',
        depositCashapp: 'on',
        balanceOnline: 'on',
        balanceCash: 'on',
        balanceZelle: 'on',
        balanceCashapp: 'on',
        balanceTerminal: 'on',
      }).expect(200);
      await saveAs('/settings/policies', {
        rescheduleHours: '24',
        freeReschedules: '2',
        cancelHours: '24',
        lateFeeMinutes: '15',
        lateFee: '10',
        policyText: 'Be kind.',
      }).expect(200);
      expect(
        (
          await saveAs('/settings/emails', {
            reminderHours: '48',
            adminAlertEmails: 'one@example.com, nope',
          })
        ).body.fields.adminAlertEmails,
      ).toContain('nope');
      await saveAs('/settings/emails', {
        reminderHours: '72',
        adminAlertEmails: 'One@example.com, one@example.com',
      }).expect(200);
      const after = (await service.all()).settings;
      expect(after.business.name).toBe('Mado African Braids');
      expect(after.business.phone).toBe('+14437434979');
      for (const key of Object.keys(before.business))
        expect(after.business).toHaveProperty(key);
      expect(after.booking).toEqual({
        ...before.booking,
        depositCents: 4250,
        holdMinutes: 45,
      });
      expect(after.depositOptions).toMatchObject({
        zelle: false,
        cashapp: true,
      });
      expect(after.depositOptions.changedAt).toBeTruthy();
      expect(after.policy).toMatchObject({
        freeReschedules: 2,
        depositRefundable: false,
        lateFeeCents: 1000,
        text: 'Be kind.',
      });
      expect(after.emails.adminAlertEmails).toEqual(['one@example.com']);
      await service.saveSettings(
        {
          booking: before.booking,
          depositOptions: { zelle: true, cashapp: true },
        },
        actor,
      );
    });
    it('warns before special hours leave a booked client outside them, then saves on request', async () => {
      const closed = { date: '2026-12-03', closed: 'on', note: 'Holiday' };
      const asked = await saveAs('/time-off/special', closed);
      expect(asked.status).toBe(409);
      expect(asked.body.confirm.detail).toContain('stay booked');
      expect((await service.all()).settings.hours.special || []).toEqual([]);
      await saveAs('/time-off/special', {
        ...closed,
        acknowledge: 'true',
      }).expect(200);
      expect((await service.all()).settings.hours.special).toHaveLength(1);
      await saveAs('/time-off/special/remove', { date: closed.date }).expect(
        200,
      );
      expect((await service.all()).settings.hours.special).toEqual([]);
    });
    it('closes a special day to new bookings', async () => {
      await service.saveSpecialDay(
        { date: '2026-12-09', closed: true, note: '' },
        actor,
      );
      await expect(
        bookings.createHold({ ...validHold, startAt: '2026-12-09T15:00:00Z' }),
      ).rejects.toThrow();
      await service.removeSpecialDay('2026-12-09', actor);
    });
    it('blocks several days as one entry and removes them together', async () => {
      await saveAs('/availability/blocks', {
        date: '2027-01-11',
        endDate: '2027-01-13',
        allDay: 'on',
        reason: 'Trip',
      }).expect(200);
      const rows = () =>
        db.select().from(s.timeBlocks).where(eq(s.timeBlocks.reason, 'Trip'));
      const added = await rows();
      expect(added).toHaveLength(3);
      expect((await agent.get('/admin/time-off')).text).toContain(
        'Mon, Jan 11 – Wed, Jan 13, 2027',
      );
      await saveAs(`/availability/blocks/${added[0].id}/remove`, {
        series: 'true',
      }).expect(200);
      expect(await rows()).toHaveLength(0);
    });
    it('shows every settings page, and previews and restores email wording', async () => {
      for (const path of [
        '/settings',
        '/settings/payments',
        '/settings/policies',
        '/settings/emails',
        '/settings/health',
        '/email-templates',
        '/availability',
        '/time-off',
        '/seo',
        '/settings?tab=security',
        '/notifications',
        '/notifications?view=unread&page=2',
        '/calendar',
      ])
        expect([path, (await agent.get('/admin' + path)).status]).toEqual([
          path,
          200,
        ]);
      const page = await agent.get('/admin/email-templates');
      const keys = new Set(
        [...page.text.matchAll(/name="template" value="([^"]+)"/g)].map(
          (match) => match[1],
        ),
      );
      expect(keys.size).toBeGreaterThan(5);
      for (const template of keys) {
        const mail = await saveAs('/email-templates/preview', {
          template,
          subject: 'Subject',
          intro: 'Hello <script>x</script> there',
        });
        expect([template, mail.status]).toEqual([template, 200]);
        expect(mail.text).not.toContain('<script>x');
        expect(mail.headers['content-security-policy']).toContain('sandbox');
      }
      expect(keys).not.toContain('password-reset');
      await saveAs('/email-templates', {
        template: 'booking-confirmation',
        subject: 'Yours',
        intro: 'Mine',
      }).expect(200);
      await saveAs('/email-templates/reset', {
        template: 'booking-confirmation',
      }).expect(200);
      expect(
        (await service.all()).settings.emailTemplates['booking-confirmation'],
      ).toBeUndefined();
    });
    it('does not call messages from before email was switched on late', async () => {
      const cutoff = new Date('2026-11-21T00:00:00Z');
      const job = (key, values) =>
        db.insert(s.jobs).values({
          type: 'email',
          payload: {},
          status: 'pending',
          dedupeKey: key,
          ...values,
        });
      const before = (await service.health(cutoff)).late;
      const old = new Date('2026-11-17T00:00:00Z');
      await job('health-old', { runAt: old, createdAt: old });
      expect((await service.health(cutoff)).late).toBe(before);
      const recent = new Date('2026-11-25T00:00:00Z');
      await job('health-new', { runAt: recent, createdAt: recent });
      expect((await service.health(cutoff)).late).toBe(before + 1);
      await createNotificationRepository(db).heartbeat(now.toJSDate());
      expect(+(await service.health(cutoff)).lastRun).toBe(+now.toJSDate());
    });
    it('accepts Microsoft push devices, refuses unknown services, and saves alert choices', async () => {
      const device = (host) =>
        saveAs('/api/push-subscriptions', {
          endpoint: `https://${host}/w/?token=abc`,
          keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
        });
      const before = await device('evil.example.com');
      // Without server keys push is off entirely.
      expect([400, 503]).toContain(before.status);
      await saveAs('/notifications/preferences', {
        quiet: 'on',
        quietFrom: '22:00',
        quietTo: '07:00',
        push_bookings: 'on',
      }).expect(200);
      const { alerts } = (await service.all()).settings;
      expect(alerts.owners[1]).toMatchObject({
        quiet: true,
        push: { bookings: true, changes: false },
      });
      expect(
        (
          await saveAs('/notifications/preferences', {
            quiet: 'on',
            quietFrom: '07:00',
            quietTo: '07:00',
          })
        ).status,
      ).toBe(400);
      await request(app).get('/admin/manifest.webmanifest').expect(200);
      expect((await request(app).get('/admin/notifications')).status).toBe(303);
    });
    it('denies management access to a non-owner account', async () => {
      await db
        .update(s.admins)
        .set({ role: 'staff' })
        .where(eq(s.admins.id, 1));
      const response = await agent
        .post('/admin/styles/save')
        .set('Accept', 'application/json')
        .send({ ...styleValues, _csrf: token });
      await db
        .update(s.admins)
        .set({ role: 'owner' })
        .where(eq(s.admins.id, 1));
      expect(response.status).toBe(401);
    });
    it('clears every appointment only when confirmed and settled, and keeps the studio', async () => {
      const directory = resolve('tmp', 'clear-' + database);
      const hold = await bookings.createHold({
        ...validHold,
        startAt: '2026-12-22T15:00:00Z',
        email: 'clear@example.test',
      });
      await db.insert(s.payments).values({
        bookingId: hold.id,
        type: 'deposit',
        provider: 'manual',
        method: 'zelle',
        amountCents: 3000,
        createdAt: new Date(),
      });
      await db.insert(s.jobs).values({
        type: 'email',
        payload: { template: 'password-reset' },
        runAt: new Date(),
        status: 'done',
        dedupeKey: 'clear-keep',
      });
      await db.insert(s.emailSuppressions).values({
        email: 'stop@example.test',
        reason: 'unsubscribed',
      });
      const kept = async () =>
        Promise.all(
          [s.styles, s.styleVariants, s.addons, s.admins, s.timeBlocks].map(
            async (table) => (await db.select().from(table)).length,
          ),
        );
      const before = await kept();
      const found = await previewClear(db);
      const confirm = found.bookings.length;
      expect(confirm).toBeGreaterThan(0);
      const clear = (options) =>
        clearAppointments(db, { directory, ...options });
      await expect(clear({ confirm: confirm + 1 })).rejects.toThrow(
        'Nothing was deleted',
      );
      await db.delete(s.checkoutAttempts);
      await db.delete(s.paymentBatches);
      await db
        .update(s.jobs)
        .set({ status: 'done' })
        .where(eq(s.jobs.type, 'refundConflict'));
      await expect(clear({ confirm })).rejects.toThrow('not been refunded');
      expect(await db.select().from(s.bookings)).toHaveLength(confirm);
      const result = await clear({ confirm, settled: true });
      const copy = JSON.parse(await readFile(result.file, 'utf8'));
      expect(copy.bookings).toHaveLength(confirm);
      for (const table of [
        s.bookings,
        s.clients,
        s.payments,
        s.paymentProofs,
        s.emailLog,
        s.notifications,
      ])
        expect(await db.select().from(table)).toEqual([]);
      expect(await kept()).toEqual(before);
      expect(await db.select().from(s.emailSuppressions)).toHaveLength(1);
      expect(
        await db
          .select()
          .from(s.jobs)
          .where(eq(s.jobs.dedupeKey, 'clear-keep')),
      ).toHaveLength(1);
      for (const path of ['', '/bookings', '/clients', '/calendar'])
        await agent.get('/admin' + path).expect(200);
      await bookings.createHold({
        ...validHold,
        startAt: '2026-12-22T15:00:00Z',
      });
      await rm(directory, { recursive: true, force: true });
    });
  },
);
