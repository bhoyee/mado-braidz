import { describe, it, expect } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import argon2 from 'argon2';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBookingService,
  accessToken,
} from '../src/services/bookingService.js';
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
    await service.reviewPaymentProof(proof.id, 'reject', owner);
    const emails = repo.jobRows.filter(
      (j) => j.payload.template === 'payment-rejected',
    );
    expect(emails).toHaveLength(1);
    expect(emails[0].payload).toMatchObject({
      method: 'cashapp',
      paymentType: 'deposit',
      amountCents: 3000,
    });
    expect(JSON.stringify(emails)).not.toContain('Transfer not received');
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
  it('finds multiple exact contact matches and grants only session-bound payment access', async () => {
    const { repo, hold, service } = await setup();
    const second = await service.createHold(validHold);
    const third = await service.createHold({
      ...validHold,
      email: 'other@example.test',
      phone: '+12025550123',
    });
    const provider = fakeStripe();
    const app = createApp({
      config: parseEnv(paymentConfig),
      catalog: fixtureCatalog(),
      bookingRepository: repo,
      stripeProvider: provider,
    });
    const agent = request.agent(app);
    const page = await agent.get('/pay').expect(200);
    expect(page.text).not.toContain('name="bookingCode"');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const found = await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: validHold.phone })
      .expect(200);
    expect(found.text).toContain(hold.ref);
    expect(found.text).toContain(second.ref);
    expect(found.text).not.toContain(third.ref);
    expect(found.text).not.toContain(hold.manageToken);
    const emailMatches = await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: validHold.email })
      .expect(200);
    expect(emailMatches.text).toContain(hold.ref);
    expect(emailMatches.text).toContain(second.ref);
    expect(emailMatches.text).not.toContain(third.ref);
    const codeMatch = await agent
      .post('/pay/search')
      .type('form')
      .send({ _csrf: csrf, query: hold.ref })
      .expect(200);
    expect(codeMatch.text).toContain(hold.ref);
    expect(codeMatch.text).not.toContain(second.ref);
    expect(codeMatch.text).not.toContain(third.ref);
    const paymentUrl = found.text.match(
      /href="(\/pay\/appointment\/[a-f0-9]+)"/,
    )[1];
    await request(app).get(paymentUrl).expect(404);
    await agent.get(paymentUrl).expect(200);
    const checkout = await agent
      .post(`/api/bookings/${hold.ref}/checkout`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(200);
    expect(provider.calls.create[0].params.cancel_url).toContain(
      '/pay/appointment/',
    );
    expect(provider.calls.create[0].params.customer_email).toBeUndefined();
    expect(provider.calls.create[0].params.cancel_url).not.toContain(
      hold.manageToken,
    );
    await agent
      .get('/api/bookings/payment-status')
      .query({ session_id: checkout.body.sessionId })
      .expect(200)
      .expect((r) => {
        expect(r.body.manageUrl).toMatch(/^\/pay\/appointment\//);
        expect(JSON.stringify(r.body)).not.toContain(hold.manageToken);
      });
    await agent
      .get(`/api/bookings/${hold.ref}/status`)
      .expect(200)
      .expect((r) => expect(r.body.manageUrl).toMatch(/^\/pay\/appointment\//));
    provider.sessions.get(checkout.body.sessionId).cancel_url =
      paymentConfig.APP_URL + '/booking/' + hold.manageToken;
    await agent
      .post(`/api/bookings/${hold.ref}/checkout`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(409)
      .expect((r) =>
        expect(JSON.stringify(r.body)).not.toContain(hold.manageToken),
      );
    await agent
      .post(`/api/bookings/${hold.ref}/cancel`)
      .set('x-csrf-token', csrf)
      .send({})
      .expect(404);
  });
  it('supports one-field lookup with session-bound payment access and private proof review', async () => {
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
      let paymentUrl;
      for (const query of [
        validHold.email.toUpperCase(),
        '(443) 743-4979',
        hold.ref.toLowerCase(),
      ]) {
        const result = await agent
          .post('/pay/search')
          .type('form')
          .send({ _csrf: csrf, query })
          .expect(200);
        expect(result.text).toContain('Pay now');
        expect(result.text).not.toContain(hold.manageToken);
        paymentUrl = result.text.match(
          /href="(\/pay\/appointment\/[a-f0-9]+)"/,
        )[1];
      }
      await request(app).get(paymentUrl).expect(404);
      await agent.get(paymentUrl).expect(200);
      await agent
        .post('/pay/search')
        .type('form')
        .send({ _csrf: csrf, query: 'unknown@example.test' })
        .expect(200)
        .expect((r) => expect(r.text).toContain('No pending payments found.'));
      await agent
        .post('/api/bookings/' + hold.ref + '/cancel')
        .set('x-csrf-token', csrf)
        .send({})
        .expect(404);
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
      expect(
        repo.jobRows.filter((j) => j.payload.template === 'payment-submitted'),
      ).toHaveLength(1);
      const visit = await agent
        .get('/booking/' + accessToken(hold.ref, paymentConfig.SESSION_SECRET))
        .expect(200);
      const summary = visit.text.match(
        /aria-label="Your payment summary"[\s\S]*?<\/aside>/,
      )[0];
      expect(summary).toContain('Zelle payment sent');
      expect(summary).toContain('Awaiting verification');
      expect(summary).toContain('$30');
      expect(summary).not.toContain('$0');
      expect(summary).toContain('$150');
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
