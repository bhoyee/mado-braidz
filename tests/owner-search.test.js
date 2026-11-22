import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { memoryBookingRepository } from './fixtures/booking.js';
import { memoryAdminRepository } from './fixtures/admin.js';
import { paymentConfig, fakeStripe } from './fixtures/stripe.js';
import { searchPortalPages } from '../src/services/ownerSearch.js';
const password = 'Search-owner-test-password!';
async function fixture() {
  const repo = await memoryBookingRepository(),
    admins = memoryAdminRepository(repo, {
      id: 1,
      role: 'owner',
      name: 'Owner',
      email: 'owner@example.test',
      passwordHash: await argon2.hash(password),
      authVersion: 0,
    });
  admins.searchPortal = vi.fn(async () => [
    {
      label: 'Clients',
      items: [
        {
          title: 'Maya',
          description: 'maya@example.test',
          href: '/admin/clients/1',
        },
      ],
    },
  ]);
  const app = createApp({
    config: parseEnv(paymentConfig),
    bookingRepository: repo,
    adminRepository: admins,
    catalog: fixtureCatalog(),
    stripeProvider: fakeStripe(),
  });
  const agent = request.agent(app);
  const signIn = async () => {
    const page = await agent.get('/admin/login');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    await agent
      .post('/admin/login')
      .send({ email: 'owner@example.test', password, _csrf: csrf })
      .expect(303);
  };
  return { app, agent, admins, signIn };
}
describe('Owner portal search', () => {
  it('finds the current owner pages and does not restore hidden maintenance menus', () => {
    expect(searchPortalPages('opening hours')[0].href).toBe(
      '/admin/availability',
    );
    expect(searchPortalPages('PASSWORD')[0].href).toBe(
      '/admin/settings?tab=security',
    );
    expect(searchPortalPages('cash app')[0].href).toBe(
      '/admin/payment-reviews',
    );
    expect(searchPortalPages('page redirects')).toEqual([]);
    expect(searchPortalPages('nothing matches this')).toEqual([]);
  });
  it('requires an owner session before searching private records', async () => {
    const f = await fixture();
    await request(f.app)
      .get('/admin/api/search?q=maya')
      .set('Accept', 'application/json')
      .expect(401);
    expect(f.admins.searchPortal).not.toHaveBeenCalled();
    await f.signIn();
    f.admins.rows[0].role = 'staff';
    await f.agent
      .get('/admin/api/search?q=maya')
      .set('Accept', 'application/json')
      .expect(401);
    expect(f.admins.searchPortal).not.toHaveBeenCalled();
  });
  it('validates queries, prevents caching and returns private results only after sign-in', async () => {
    const f = await fixture();
    await f.signIn();
    for (const q of ['', 'a', 'x'.repeat(121)])
      await f.agent
        .get('/admin/api/search')
        .query({ q })
        .set('Accept', 'application/json')
        .expect(400);
    expect(f.admins.searchPortal).not.toHaveBeenCalled();
    const result = await f.agent
      .get('/admin/api/search?q=maya')
      .set('Accept', 'application/json')
      .expect(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.groups[0].items[0].href).toBe('/admin/clients/1');
  });
  it('returns an empty result and caps groups without letting one category consume the list', async () => {
    const f = await fixture();
    await f.signIn();
    f.admins.searchPortal.mockResolvedValueOnce([]);
    expect(
      (await f.agent.get('/admin/api/search?q=unmatchedterm')).body.groups,
    ).toEqual([]);
    f.admins.searchPortal.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, i) => ({
        label: 'Group ' + i,
        items: Array.from({ length: 10 }, (_, j) => ({
          title: 'Item ' + j,
          href: '/admin/bookings/1',
        })),
      })),
    );
    const result = await f.agent
      .get('/admin/api/search?q=unmatchedterm')
      .expect(200);
    expect(result.body.groups).toHaveLength(6);
    expect(
      result.body.groups.flatMap((v) => v.items).length,
    ).toBeLessThanOrEqual(20);
  });
});
