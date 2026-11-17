import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyTurnstile } from '../src/services/turnstileService.js';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { fixtureCatalog } from './fixtures/catalog.js';
const config = {
  TURNSTILE_ENABLED: true,
  TURNSTILE_SECRET_KEY: 'unit-test-only',
  APP_URL: 'https://madoafricanbraidz.com',
};
afterEach(() => vi.unstubAllGlobals());
describe('Turnstile verification', () => {
  it('accepts only a successful verification for the configured hostname and form action', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        hostname: 'madoafricanbraidz.com',
        action: 'booking',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await verifyTurnstile(config, 'one-use-token', '127.0.0.1', 'booking');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].body.get('response')).toBe(
      'one-use-token',
    );
  });
  it.each([
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { success: true, hostname: 'another.example', action: 'booking' },
    { success: true, hostname: 'madoafricanbraidz.com', action: 'contact' },
  ])(
    'rejects invalid, replayed or wrongly scoped responses',
    async (result) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: async () => result }),
      );
      await expect(
        verifyTurnstile(config, 'token', '127.0.0.1', 'booking'),
      ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    },
  );
  it('rejects empty tokens before requesting Cloudflare and fails closed on provider errors', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      verifyTurnstile(config, '', '', 'contact'),
    ).rejects.toMatchObject({ code: 'VERIFICATION_FAILED' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      verifyTurnstile(config, 'token', '', 'contact'),
    ).rejects.toMatchObject({ code: 'VERIFICATION_UNAVAILABLE', status: 503 });
  });
  it('honours the explicit disabled switch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await verifyTurnstile(
      { ...config, TURNSTILE_ENABLED: false },
      '',
      '',
      'contact',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('protected contact preview', () => {
  function app() {
    return createApp({
      config: parseEnv({
        ...config,
        NODE_ENV: 'test',
        SESSION_SECRET: 'turnstile-test-session-secret-32-characters',
        DATABASE_URL: 'mysql://unused:unused@localhost/mado',
        UPLOAD_DIR: 'tmp/test-uploads',
        TURNSTILE_SITE_KEY: 'unit-test-site',
      }),
      catalog: fixtureCatalog(),
    });
  }
  it('keeps messages disabled, protects POST with CSRF and rejects missing or invalid verification', async () => {
    const agent = request.agent(app());
    const page = await agent.get('/contact').expect(200);
    expect(page.text).toContain('<fieldset disabled>');
    expect(page.text).toContain('data-action="contact"');
    expect(page.text).not.toContain(config.TURNSTILE_SECRET_KEY);
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ success: false }) });
    vi.stubGlobal('fetch', fetchMock);
    await agent.post('/contact').send({}).expect(403);
    await agent.post('/contact').send({ _csrf: csrf }).expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
    await agent
      .post('/contact')
      .send({ _csrf: csrf, 'cf-turnstile-response': 'invalid' })
      .expect(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('checks contact action/hostname and never claims a message was sent before email setup', async () => {
    const agent = request.agent(app());
    const page = await agent.get('/contact');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        hostname: 'madoafricanbraidz.com',
        action: 'contact',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const response = await agent
      .post('/contact')
      .send({ _csrf: csrf, 'cf-turnstile-response': 'valid-once' })
      .expect(503);
    expect(response.text).toContain('nothing entered here is saved');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('rejects honeypot fields and rate limits repeated submissions', async () => {
    const agent = request.agent(app());
    const page = await agent.get('/contact');
    const csrf = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await agent
      .post('/contact')
      .send({ _csrf: csrf, website: 'spam' })
      .expect(400);
    for (let n = 0; n < 4; n++)
      await agent.post('/contact').send({ _csrf: csrf }).expect(400);
    await agent.post('/contact').send({ _csrf: csrf }).expect(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
