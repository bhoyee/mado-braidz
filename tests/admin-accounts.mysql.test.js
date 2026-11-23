import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import argon2 from 'argon2';
import mysql from 'mysql2/promise';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createDatabase } from '../src/db/index.js';
import * as s from '../src/db/schema.js';
import { addOwner } from '../src/services/adminAccounts.js';
import { createAdminAuthService } from '../src/services/adminAuthService.js';
import { createAdminRepository } from '../src/services/adminRepository.js';
import nunjucks from 'nunjucks';

it('lets an owner without two-factor submit the login form', () => {
  const env = new nunjucks.Environment(
    new nunjucks.FileSystemLoader('src/views'),
    { autoescape: true },
  );
  const html = env.render('admin/auth.njk', { page: 'login', showCode: true });
  const input = html.match(/<input name="code"[^>]*>/)[0];
  expect(input).not.toContain('required');
});

describe.skipIf(process.env.BOOKING_DATABASE_TEST !== '1')(
  'adding a second owner with a real disposable MySQL database',
  () => {
    let connection, db, pool, auth, link;
    const database = 'mado_admin_test_' + randomBytes(6).toString('hex');
    const first = 'First-owner-password!',
      second = 'Second-owner-password!';
    beforeAll(async () => {
      const url = new URL(
        process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
      );
      connection = await mysql.createConnection(url.toString());
      await connection.query(
        `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4`,
      );
      url.pathname = '/' + database;
      ({ db, pool } = createDatabase(url.toString()));
      await migrate(db, { migrationsFolder: 'src/db/migrations' });
      await db.insert(s.admins).values([
        {
          id: 1,
          name: 'First',
          email: 'first@example.test',
          passwordHash: await argon2.hash(first),
          role: 'owner',
        },
        {
          id: 2,
          name: 'Staff',
          email: 'staff@example.test',
          passwordHash: 'unused',
          role: 'staff',
        },
      ]);
      auth = createAdminAuthService(
        createAdminRepository(db),
        { SESSION_SECRET: 'x'.repeat(32), APP_URL: 'https://example.test' },
        undefined,
        async (_to, resetUrl) => {
          link = resetUrl;
        },
      );
    }, 30000);
    afterAll(async () => {
      await pool?.end();
      await connection?.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await connection?.end();
    });
    const rows = () => db.select().from(s.admins).orderBy(s.admins.id);

    it('adds an owner who sets their own password, leaving the first untouched', async () => {
      const [before] = await rows();
      const added = await addOwner(db, {
        email: ' Second@Example.TEST ',
        name: 'Second',
      });
      expect(added).toMatchObject({
        email: 'second@example.test',
        created: true,
      });
      await auth.requestReset('second@example.test', '127.0.0.1');
      await auth.resetPassword(link.split('#')[1], second, '127.0.0.1');
      const grant = await auth.login(
        'second@example.test',
        second,
        '',
        '127.0.0.1',
      );
      expect(grant.id).toBe(added.id);
      const current = await auth.authenticate({
        ...grant,
        expiresAt: Infinity,
      });
      expect(current.role).toBe('owner');
      expect((await rows())[0]).toEqual(before);
      expect(
        (await auth.login('first@example.test', first, '', '127.0.0.1')).id,
      ).toBe(1);
      const audits = await db
        .select()
        .from(s.auditLog)
        .where(eq(s.auditLog.adminId, added.id));
      expect(audits.map((row) => row.action)).toContain('owner_added');
    });
    it('changes nothing when run again or given an invalid or staff email', async () => {
      const before = await rows();
      expect(
        (await addOwner(db, { email: 'second@example.test', name: 'Other' }))
          .created,
      ).toBe(false);
      await expect(
        addOwner(db, { email: 'a@example.test,b@example.test', name: 'Two' }),
      ).rejects.toThrow();
      await expect(
        addOwner(db, { email: 'staff@example.test', name: 'Staff' }),
      ).rejects.toThrow('non-owner');
      expect(await rows()).toEqual(before);
    });
  },
);
