import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import { rm } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/db/index.js';
import * as s from '../src/db/schema.js';
import { createManagementService } from '../src/services/managementService.js';
import { createBookingRepository } from '../src/services/bookingRepository.js';
import { createBookingService } from '../src/services/bookingService.js';
import { createApp } from '../src/app.js';
import { createAdminRepository } from '../src/services/adminRepository.js';
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
      app = createApp({
        config: parseEnv({
          ...paymentConfig,
          DATABASE_URL: url.toString(),
          UPLOAD_DIR: uploadDir,
        }),
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
      ).rejects.toThrow('overlaps');
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
  },
);
