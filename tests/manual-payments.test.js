import { describe, it, expect } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import argon2 from 'argon2';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBookingService } from '../src/services/bookingService.js';
import { createPaymentService } from '../src/services/paymentService.js';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { memoryBookingRepository, validHold, now } from './fixtures/booking.js';
import { fakeStripe, paidEvent, paymentConfig } from './fixtures/stripe.js';
import { fixtureCatalog } from './fixtures/catalog.js';
const owner = { id: 1, role: 'owner' };
async function setup(paymentChoice = 'deposit') {
  const repo = await memoryBookingRepository();
  let time = now;
  const service = createBookingService(
    repo,
    () => time,
    paymentConfig.SESSION_SECRET,
  );
  const hold = await service.createHold({ ...validHold, paymentChoice });
  return {
    repo,
    service,
    hold,
    advance: (hours) => (time = now.plus({ hours })),
  };
}
describe('manual payment review', () => {
  it.each(['deposit', 'full'])(
    'holds proof for review without crediting %s, then approves exactly once',
    async (paymentChoice) => {
      const { repo, service, hold } = await setup(paymentChoice);
      const submission = await service.submitPaymentProof(hold.id, {
        method: 'zelle',
        path: 'private.webp',
      });
      expect(repo.rows[0]).toMatchObject({
        status: 'pending_payment',
        paidCents: 0,
      });
      expect(submission.amountCents).toBe(
        paymentChoice === 'full' ? 18000 : 3000,
      );
      expect(repo.rows[0].holdExpiresAt.getTime()).toBe(
        now.plus({ hours: 24 }).toMillis(),
      );
      await expect(
        service.reserveCheckout(hold.id, paymentChoice),
      ).rejects.toMatchObject({ code: 'REVIEW_PENDING' });
      await Promise.all([
        service.reviewPaymentProof(submission.id, 'approve', owner),
        service.reviewPaymentProof(submission.id, 'approve', owner),
      ]);
      expect(repo.paymentRows.length).toBe(1);
      expect(repo.auditRows.length).toBe(1);
      expect(repo.rows[0].status).toBe('confirmed');
      expect(repo.rows[0].paidCents).toBe(submission.amountCents);
    },
  );
  it('rejects duplicate proof submissions, staff decisions, and initial rejection releases the chair', async () => {
    const { repo, service, hold } = await setup();
    const proof = await service.submitPaymentProof(hold.id, {
      method: 'cashapp',
      path: 'private.webp',
    });
    await expect(
      service.submitPaymentProof(hold.id, {
        method: 'cashapp',
        path: 'other.webp',
      }),
    ).rejects.toMatchObject({ code: 'REVIEW_PENDING' });
    await expect(
      service.reviewPaymentProof(proof.id, 'approve', { id: 2, role: 'staff' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await service.reviewPaymentProof(
      proof.id,
      'reject',
      owner,
      'Transfer not received',
    );
    expect(repo.rows[0]).toMatchObject({ status: 'cancelled', paidCents: 0 });
  });
  it('does not confirm a late proof if the time filled, and does not record money', async () => {
    const { repo, service, hold, advance } = await setup();
    const proof = await service.submitPaymentProof(hold.id, {
      method: 'zelle',
      path: 'private.webp',
    });
    advance(25);
    await service.releaseHold(hold.id, 'expired');
    for (let i = 0; i < 3; i++)
      repo.rows.push({
        ...repo.rows[0],
        id: 20 + i,
        ref: 'OTHER' + i,
        status: 'confirmed',
      });
    await expect(
      service.reviewPaymentProof(proof.id, 'approve', owner),
    ).rejects.toMatchObject({ code: 'PAYMENT_CONFLICT' });
    expect(repo.paymentRows).toHaveLength(0);
    expect(repo.rows[0].status).toBe('expired');
  });
  it('records a balance only after owner approval without altering the confirmed chair', async () => {
    const { repo, service, hold } = await setup();
    const provider = fakeStripe();
    const payments = createPaymentService(
      repo,
      provider,
      paymentConfig,
      () => now,
    );
    const checkout = await payments.checkout(hold.ref, hold.manageToken);
    await payments.handleEvent(
      paidEvent(provider.sessions.get(checkout.sessionId)),
    );
    const proof = await service.submitPaymentProof(hold.id, {
      method: 'cashapp',
      path: 'private.webp',
    });
    expect(repo.rows[0].paidCents).toBe(3000);
    await service.reviewPaymentProof(proof.id, 'approve', owner);
    expect(repo.rows[0]).toMatchObject({
      status: 'confirmed',
      paidCents: 18000,
      balanceCents: 0,
      paymentStatus: 'paid_in_full',
    });
  });
  it('refuses proof alongside an existing Stripe checkout', async () => {
    const { repo, service, hold } = await setup();
    await createPaymentService(
      repo,
      fakeStripe(),
      paymentConfig,
      () => now,
    ).checkout(hold.ref, hold.manageToken);
    await expect(
      service.submitPaymentProof(hold.id, {
        method: 'zelle',
        path: 'private.webp',
      }),
    ).rejects.toMatchObject({ code: 'CHECKOUT_OPEN' });
  });
});
describe('public pay lookup and private proof routes', () => {
  it('protects lookup, validates proof bytes/ownership, and requires owner credentials to review', async () => {
    const { repo, hold } = await setup();
    const uploadDir = await mkdtemp(join(tmpdir(), 'mado-proof-test-'));
    const password = 'owner-test-only-at-least-12';
    const admin = {
      ...owner,
      email: 'owner@example.test',
      passwordHash: await argon2.hash(password),
    };
    const config = parseEnv({
      ...paymentConfig,
      UPLOAD_DIR: uploadDir,
      ZELLE_RECIPIENT: '4437434979',
      CASHAPP_CASHTAG: '$magdalinearrey',
    });
    const app = createApp({
      config,
      catalog: fixtureCatalog({
        findAdmin: async (email) => (email === admin.email ? admin : null),
      }),
      bookingRepository: repo,
      stripeProvider: fakeStripe(),
    });
    try {
      const agent = request.agent(app);
      const page = await agent.get('/pay').expect(200);
      const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
      await agent
        .post('/pay/search')
        .type('form')
        .send({ _csrf: csrf, query: validHold.email })
        .expect(200)
        .expect((r) => {
          expect(r.text).not.toContain(hold.ref);
          expect(r.text).toContain('confirmation code');
        });
      await agent
        .post('/pay/search')
        .type('form')
        .send({
          _csrf: csrf,
          query: 'unknown@example.test',
          bookingCode: hold.ref,
        })
        .expect(200)
        .expect((r) => expect(r.text).toContain('No pending payments found.'));
      await agent
        .post('/pay/search')
        .type('form')
        .send({ _csrf: csrf, query: validHold.email, bookingCode: hold.ref })
        .expect(200)
        .expect((r) => expect(r.text).toContain('Pay now'));
      await request(app).post(`/api/bookings/${hold.ref}/proof`).expect(403);
      await agent
        .post(`/api/bookings/${hold.ref}/proof`)
        .set('x-csrf-token', csrf)
        .field('method', 'zelle')
        .attach('proof', Buffer.from('<script>bad</script>'), 'fake.png')
        .expect(400);
      const image = await sharp({
        create: { width: 10, height: 10, channels: 3, background: '#fff' },
      })
        .png()
        .toBuffer();
      await agent
        .post(`/api/bookings/${hold.ref}/proof`)
        .set('x-csrf-token', csrf)
        .field('method', 'zelle')
        .attach('proof', image, 'proof.png')
        .expect(200);
      expect(repo.rows[0].paidCents).toBe(0);
      expect(await readdir(uploadDir)).toHaveLength(1);
      await agent
        .post(`/api/bookings/${hold.ref}/checkout`)
        .set('x-csrf-token', csrf)
        .send({})
        .expect(409);
      await request(app).get('/admin/payment-reviews/1/image').expect(401);
      const ownerAgent = request.agent(app);
      const review = await ownerAgent
        .get('/admin/payment-reviews')
        .auth(admin.email, password)
        .expect(200);
      const reviewCsrf = review.text.match(/name="_csrf" value="([^"]+)"/)[1];
      await ownerAgent
        .get('/admin/payment-reviews/1/image')
        .auth(admin.email, password)
        .expect(200)
        .expect('Content-Type', /image\/webp/);
      await ownerAgent
        .post('/admin/payment-reviews/1')
        .auth(admin.email, password)
        .type('form')
        .send({
          _csrf: reviewCsrf,
          decision: 'approve',
          note: 'Received in account',
        })
        .expect(303);
      expect(repo.rows[0]).toMatchObject({
        status: 'confirmed',
        paidCents: 3000,
      });
    } finally {
      await rm(uploadDir, { recursive: true, force: true });
    }
  });
});
