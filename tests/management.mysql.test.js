import 'dotenv/config';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import mysql from 'mysql2/promise';
import argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
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
        config: parseEnv({ ...paymentConfig, DATABASE_URL: url.toString() }),
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
    afterAll(async () => {
      await pool?.end();
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
