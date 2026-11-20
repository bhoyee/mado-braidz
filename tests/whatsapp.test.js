import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createWhatsAppService } from '../src/services/whatsappService.js';
import { createNotificationService } from '../src/services/notificationService.js';
import { parseEnv } from '../src/config/env.js';
import { createApp } from '../src/app.js';
import { fixtureCatalog } from './fixtures/catalog.js';
import { paymentConfig } from './fixtures/stripe.js';
const config = parseEnv({
  ...paymentConfig,
  WHATSAPP_NUMBER: '+14437434979',
  WHATSAPP_OWNER_NUMBER: '+14437434979',
  WHATSAPP_PHONE_NUMBER_ID: '123456',
  WHATSAPP_ACCESS_TOKEN: 'private-test-token',
  WHATSAPP_ALERTS_ENABLED: 'true',
  WHATSAPP_ALERTS_START_AT: '2026-11-19T10:00:00Z',
});
describe('WhatsApp chat and owner alerts', () => {
  it('preserves the formatted owner booking message in the CallMeBot request', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      text: async () => 'Message queued.',
    }));
    await createWhatsAppService(
      {
        ...config,
        WHATSAPP_PROVIDER: 'callmebot',
        CALLMEBOT_API_KEY: 'test-key',
      },
      send,
    ).sendOwnerAlert({
      title: 'Booking',
      whatsappText:
        '💰 NEW BOOKING\n👤 Test Client\n💵 Paid $30.00 · Balance $130.00',
      url: '/admin/bookings/1',
    });
    expect(new URL(send.mock.calls[0][0]).searchParams.get('text')).toBe(
      '💰 NEW BOOKING\n👤 Test Client\n💵 Paid $30.00 · Balance $130.00\n\nhttp://localhost:4780/admin/bookings/1',
    );
  });
  it('identifies a paused CallMeBot account even when the provider returns a 2xx response', async () => {
    const service = createWhatsAppService(
      {
        ...config,
        WHATSAPP_PROVIDER: 'callmebot',
        CALLMEBOT_API_KEY: 'private-owner-key',
      },
      async () => ({
        ok: true,
        status: 208,
        text: async () =>
          '<p>Your Account is Paused due to technical issues.</p>',
      }),
    );
    await expect(service.sendOwnerAlert({ title: 'Booking' })).rejects.toThrow(
      'CallMeBot account is paused',
    );
  });
  it('supports CallMeBot with only the activated owner number and key, without Meta credentials', async () => {
    const callmebot = parseEnv({
      ...paymentConfig,
      WHATSAPP_PROVIDER: 'callmebot',
      WHATSAPP_OWNER_NUMBER: '+2349094135585',
      CALLMEBOT_API_KEY: 'private-owner-key',
      WHATSAPP_ALERTS_ENABLED: 'true',
      WHATSAPP_ALERTS_START_AT: '2026-11-19T10:00:00Z',
    });
    const send = vi.fn(async () => ({
      ok: true,
      text: async () => '<b>Message queued.</b>',
    }));
    const result = await createWhatsAppService(callmebot, send).sendOwnerAlert({
      title: 'A chair is booked',
      body: 'MB-TEST',
      url: '/admin/bookings/1',
    });
    expect(result).toBe('callmebot:accepted');
    const url = new URL(send.mock.calls[0][0]);
    expect(url.origin).toBe('https://api.callmebot.com');
    expect(url.searchParams.get('phone')).toBe('+2349094135585');
    expect(url.searchParams.get('apikey')).toBe('private-owner-key');
    expect(url.searchParams.get('text')).toContain('/admin/bookings/1');
    expect(send.mock.calls[0][1].redirect).toBe('error');
    expect(() =>
      parseEnv({
        ...paymentConfig,
        WHATSAPP_PROVIDER: 'callmebot',
        WHATSAPP_OWNER_NUMBER: '+2349094135585',
        WHATSAPP_ALERTS_START_AT: '2026-11-19T10:00:00Z',
        WHATSAPP_ALERTS_ENABLED: 'true',
        CALLMEBOT_API_KEY: '',
      }),
    ).toThrow(/CALLMEBOT_API_KEY/);
  });
  it('does not treat CallMeBot HTTP 200 error pages as successful alerts or expose their contents', async () => {
    const result = createWhatsAppService(
      {
        ...config,
        WHATSAPP_PROVIDER: 'callmebot',
        CALLMEBOT_API_KEY: 'private-owner-key',
      },
      async () => ({
        ok: true,
        text: async () => 'ERROR: invalid apikey private-owner-key',
      }),
    );
    await expect(result.sendOwnerAlert({ title: 'Booking' })).rejects.toThrow(
      'CallMeBot rejected',
    );
  });
  it('stops automatic retries when CallMeBot acceptance is unknown', async () => {
    const service = createWhatsAppService(
      {
        ...config,
        WHATSAPP_PROVIDER: 'callmebot',
        CALLMEBOT_API_KEY: 'private-owner-key',
      },
      async () => ({
        ok: true,
        text: async () => 'Unrecognised provider response',
      }),
    );
    await expect(
      service.sendOwnerAlert({ title: 'Booking' }),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it('builds the public chat link from env and hides it when unset', async () => {
    const make = (number) =>
      createApp({
        config: { ...config, WHATSAPP_NUMBER: number },
        catalog: fixtureCatalog(),
      });
    const home = await request(make('+14437434979')).get('/').expect(200);
    expect(home.text).toContain('https://wa.me/14437434979?text=');
    expect(home.text).toContain('class="whatsapp-chat"');
    expect((await request(make('')).get('/')).text).not.toContain(
      'class="whatsapp-chat"',
    );
    expect(() =>
      parseEnv({ ...paymentConfig, WHATSAPP_NUMBER: 'javascript:bad' }),
    ).toThrow();
    expect(() =>
      parseEnv({ ...paymentConfig, WHATSAPP_ALERTS_ENABLED: 'true' }),
    ).toThrow();
  });
  it('sends only to the env owner with the approved three-parameter template and authenticated portal link', async () => {
    const send = vi.fn(async () => ({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid-test' }] }),
    }));
    expect(
      await createWhatsAppService(config, send).sendOwnerAlert({
        title: 'A chair is booked',
        body: 'MB-TEST',
        url: '/admin/bookings/7',
      }),
    ).toBe('wamid-test');
    const [url, options] = send.mock.calls[0],
      payload = JSON.parse(options.body);
    expect(url).toBe('https://graph.facebook.com/v27.0/123456/messages');
    expect(options.headers.Authorization).toBe('Bearer private-test-token');
    expect(payload.to).toBe('14437434979');
    expect(
      payload.template.components[0].parameters.map((v) => v.text),
    ).toEqual([
      'A chair is booked',
      'MB-TEST',
      'http://localhost:4780/admin/bookings/7',
    ]);
  });
  it('does not expose provider responses or automatically retry an uncertain send', async () => {
    await expect(
      createWhatsAppService(config, async () => ({
        ok: false,
        status: 401,
      })).sendOwnerAlert({ title: 'Booking', url: '//evil.example' }),
    ).rejects.toThrow('HTTP 401');
    await expect(
      createWhatsAppService(config, async () => {
        throw Error('private token');
      }).sendOwnerAlert({ title: 'Booking' }),
    ).rejects.toMatchObject({ uncertain: true });
  });
  it('queues new booking/review alerts once, skips historical events, and works independently of email', async () => {
    const now = new Date('2026-11-19T12:00:00Z');
    const notifications = [
      {
        id: 1,
        type: 'booking_confirmed',
        title: 'A chair is booked',
        body: 'MB-NEW',
        url: '/admin/bookings/1',
        createdAt: now,
      },
      {
        id: 2,
        type: 'payment_review',
        title: 'Payment proof needs review',
        body: 'MB-REVIEW',
        url: '/admin/payment-reviews',
        createdAt: now,
      },
      {
        id: 3,
        type: 'booking_confirmed',
        createdAt: new Date('2026-11-18T00:00:00Z'),
      },
    ];
    const jobs = [];
    const repo = {
      context: async () => ({
        bookings: [],
        clients: [],
        notifications,
        settings: {},
      }),
      pending: async () => [],
      lifecycleJobs: async () => [],
      failedJobs: async () => [],
      cleanup: async () => {},
      notification: async (id) => notifications.find((n) => n.id === id),
      queue: async (values) => {
        if (!jobs.some((j) => j.dedupeKey === values.dedupeKey))
          jobs.push({ id: jobs.length + 1, attempts: 0, ...values });
      },
      due: async () =>
        jobs.filter((j) => j.type === 'whatsapp' && j.status === 'pending'),
      saveJob: async (id, patch) =>
        Object.assign(
          jobs.find((j) => j.id === id),
          patch,
        ),
    };
    const whatsapp = { sendOwnerAlert: vi.fn(async () => 'wamid-test') };
    const service = createNotificationService(
      repo,
      { ...config, EMAIL_ENABLED: false },
      { clock: () => now, whatsapp },
    );
    await service.run();
    await service.run();
    expect(whatsapp.sendOwnerAlert).toHaveBeenCalledTimes(2);
    expect(jobs.filter((j) => j.type === 'whatsapp')).toHaveLength(2);
    expect(
      jobs.find((j) => j.dedupeKey === 'whatsapp:1').payload.providerMessageId,
    ).toBe('wamid-test');
    const disabled = createNotificationService(
      repo,
      { ...config, WHATSAPP_ALERTS_ENABLED: false },
      { clock: () => now, whatsapp },
    );
    await disabled.schedule();
    expect(jobs.filter((j) => j.type === 'whatsapp')).toHaveLength(2);
  });
});
