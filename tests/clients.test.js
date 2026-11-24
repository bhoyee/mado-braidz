import { describe, expect, it } from 'vitest';
import { groupClients, wantsNews } from '../src/services/clientGroups.js';
import {
  describeClients,
  filterClients,
  scrub,
} from '../src/services/clientService.js';
import { marketingEligible } from '../src/services/notificationService.js';

const now = new Date('2026-11-24T15:00:00Z');
const day = (n) => new Date(+now + n * 86400000);
const row = (id, name, email, phoneE164, extra = {}) => ({
  id,
  name,
  email,
  phoneE164,
  createdAt: day(-200),
  ...extra,
});
const ids = (clients, links) =>
  groupClients(clients, links).people.map((person) => person.ids);

describe('who is the same person', () => {
  const A = '+14437434979',
    B = '+14437430000';
  it('matches the same email in any case, or the same phone and name', () => {
    expect(
      ids([
        row(1, 'Ade Bola', 'ade@x.test', A),
        row(2, 'Adé  BOLA', ' ADE@X.test ', B),
        row(3, 'ade bola', 'other@x.test', A),
        row(4, 'Grace', 'grace@x.test', '+14437431111'),
      ]),
    ).toEqual([[1, 2, 3], [4]]);
  });
  it('keeps people apart when they share a phone but not a name or email', () => {
    const family = [
      row(1, 'Mum', 'mum@x.test', A),
      row(2, 'Daughter', 'girl@x.test', A),
    ];
    const { people } = groupClients(family);
    expect(people.map((p) => p.ids)).toEqual([[1], [2]]);
    expect(people.map((p) => p.possible)).toEqual([[2], [1]]);
    const apart = groupClients(family, { apart: [[1, 2]] }).people;
    expect(apart.map((p) => p.possible)).toEqual([[], []]);
    expect(ids(family, { join: [[1, 2]] })).toEqual([[1, 2]]);
  });
  it('never groups people by an empty phone or a removed record', () => {
    expect(
      ids([
        row(1, 'Removed client', 'removed-1@removed.invalid', ''),
        row(2, 'Removed client', 'removed-2@removed.invalid', ''),
      ]),
    ).toEqual([[1], [2]]);
    expect(ids([row(1, 'A', 'a@x.test', A)], { join: [[1, 99]] })).toEqual([
      [1],
    ]);
  });
});

describe('client numbers', () => {
  const booking = (id, clientId, status, startAt, extra = {}) => ({
    id,
    clientId,
    status,
    startAt,
    endAt: new Date(+startAt + 4 * 3600000),
    createdAt: new Date(+startAt - 86400000),
    paidCents: 3000,
    balanceCents: 0,
    styleName: 'Knotless Braids',
    ...extra,
  });
  const describeAll = (clients, bookings, links = {}, tags = {}) =>
    describeClients(clients, bookings, { links, tags }, now).list;
  it('counts a repeat client by completed and confirmed visits only', () => {
    const clients = [
      row(1, 'Ade', 'ade@x.test', '1'),
      row(2, 'Ade', 'ade@x.test', '1'),
      row(3, 'Grace', 'grace@x.test', '2'),
      row(4, 'Grace', 'grace@x.test', '2'),
      row(5, 'Grace', 'grace@x.test', '2'),
    ];
    const [ade, grace] = describeAll(clients, [
      booking(1, 1, 'completed', day(-40)),
      booking(2, 2, 'confirmed', day(6), { balanceCents: 15000 }),
      booking(3, 3, 'completed', day(-100)),
      booking(4, 4, 'cancelled', day(-50)),
      booking(5, 5, 'no_show', day(-20)),
    ]);
    expect(ade).toMatchObject({
      repeat: true,
      visitCount: 2,
      completed: 1,
      spentCents: 6000,
      balanceCents: 15000,
      lapsed: false,
      favourite: 'Knotless Braids',
    });
    expect(ade.nextVisit.id).toBe(2);
    expect(grace).toMatchObject({
      repeat: false,
      visitCount: 1,
      noShows: 1,
      lapsed: true,
    });
  });
  it('separates people who never finished booking from clients', () => {
    const list = describeAll(
      [row(1, 'Maybe', 'maybe@x.test', '1'), row(2, 'Real', 'r@x.test', '2')],
      [
        booking(1, 1, 'expired', day(-3), { paidCents: 0 }),
        booking(2, 2, 'confirmed', day(3), { createdAt: day(-1) }),
      ],
    );
    expect(filterClients(list, {}).map((p) => p.name)).toEqual(['Real']);
    expect(
      filterClients(list, { view: 'unbooked' }).map((p) => p.name),
    ).toEqual(['Maybe']);
    expect(filterClients(list, { view: 'new' }).map((p) => p.name)).toEqual([
      'Real',
    ]);
  });
  it('finds people by any email, phone digits or tag', () => {
    const list = describeAll(
      [
        row(1, 'Ade Bola', 'old@x.test', '+14437434979'),
        row(2, 'Ade Bola', 'new@x.test', '+14437434979'),
      ],
      [booking(1, 1, 'completed', day(-5))],
      {},
      { 1: ['Allergy'] },
    );
    for (const search of ['old@x', 'bola ade', '(443) 743', '4979', 'allergy'])
      expect(filterClients(list, { search }), search).toHaveLength(1);
    expect(filterClients(list, { search: 'nobody' })).toHaveLength(0);
    expect(list[0].otherEmails).toEqual(['old@x.test']);
  });
  it('joins notes and tags from every record', () => {
    const [person] = describeAll(
      [
        row(1, 'Ade', 'ade@x.test', '1', { notes: 'Window seat' }),
        row(2, 'Ade', 'ade@x.test', '1', { notes: null }),
        row(3, 'Ade', 'ade@x.test', '1', { notes: 'Window seat' }),
      ],
      [],
      {},
      { 1: ['VIP'], 3: ['VIP', 'Allergy'] },
    );
    expect(person.notes).toBe('Window seat');
    expect(person.tags).toEqual(['VIP', 'Allergy']);
  });
});

describe('salon news choices', () => {
  const opted = { marketingConsent: true, consentAt: day(-30) };
  it('respects an unsubscribe made on another booking', () => {
    const first = row(1, 'Ade', 'ade@x.test', '1', opted);
    const second = row(2, 'Ade', 'ADE@x.test', '1', {
      unsubscribedAt: day(-10),
    });
    expect(wantsNews(first, [first, second])).toBe(false);
    const again = row(3, 'Ade', 'ade@x.test', '1', {
      marketingConsent: true,
      consentAt: day(-1),
    });
    expect(wantsNews(again, [first, second, again])).toBe(true);
  });
  it('does not ask someone to come back when they already did', () => {
    const clients = [
      row(1, 'Ade', 'ade@x.test', '1', opted),
      row(2, 'Ade', 'ade@x.test', '1'),
    ];
    const visit = {
      id: 1,
      clientId: 1,
      status: 'completed',
      completedAt: day(-40),
      startAt: day(-40),
    };
    const eligible = (all) =>
      marketingEligible(visit, clients[0], all, now, clients, {});
    expect(eligible([visit])).toBe(true);
    for (const status of ['confirmed', 'completed'])
      expect(
        eligible([
          visit,
          {
            id: 2,
            clientId: 2,
            status,
            startAt: day(-10),
            completedAt: day(-10),
          },
        ]),
      ).toBe(false);
  });
});

it('scrubs personal details out of old records but keeps dates and amounts', () => {
  expect(
    scrub({
      status: 'completed',
      paidCents: 3000,
      clientNotes: 'Sensitive scalp',
      client: { name: 'Ade', email: 'a@x.test' },
      operation: { note: 'Called Ade', amountCents: 500 },
      list: [{ phoneE164: '+1', id: 4 }],
    }),
  ).toEqual({
    status: 'completed',
    paidCents: 3000,
    operation: { amountCents: 500 },
    list: [{ id: 4 }],
  });
  expect(scrub(null)).toBe(null);
});
