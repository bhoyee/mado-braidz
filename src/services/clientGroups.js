// Every booking stores its own client record. These rules decide which records
// are the same person, without changing or deleting any of them.
export const REMOVED_DOMAIN = '@removed.invalid';
export const isRemovedClient = (client) =>
  String(client?.email || '').endsWith(REMOVED_DOMAIN);
const email = (client) =>
  String(client.email || '')
    .trim()
    .toLowerCase();
const phone = (client) => String(client.phoneE164 || '').replace(/[^\d+]/g, '');
const name = (client) =>
  String(client.name || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

// Same email, or same phone with the same name. A shared phone with a different
// name and email stays apart: it is often a family.
export function groupClients(clients, links = {}) {
  const parent = new Map(clients.map((client) => [client.id, client.id]));
  const root = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const join = (a, b) => {
    const x = root(a),
      y = root(b);
    if (x !== y) parent.set(Math.max(x, y), Math.min(x, y));
  };
  const seen = new Map();
  for (const client of clients)
    for (const key of [
      email(client) && 'email:' + email(client),
      phone(client) && name(client) && `phone:${phone(client)}|${name(client)}`,
    ].filter(Boolean)) {
      if (seen.has(key)) join(seen.get(key), client.id);
      else seen.set(key, client.id);
    }
  for (const [a, b] of links.join || [])
    if (parent.has(a) && parent.has(b)) join(a, b);
  const groups = new Map();
  for (const client of [...clients].sort((a, b) => a.id - b.id)) {
    const key = root(client.id);
    groups.set(key, [...(groups.get(key) || []), client]);
  }
  const people = [...groups.values()].map((rows) => ({
    id: rows[0].id,
    ids: rows.map((row) => row.id),
    rows,
    possible: [],
  }));
  const personOf = new Map(
    people.flatMap((person) => person.ids.map((id) => [id, person])),
  );
  const apart = new Set(
    (links.apart || [])
      .filter(([a, b]) => personOf.has(a) && personOf.has(b))
      .map(([a, b]) =>
        [personOf.get(a).id, personOf.get(b).id].sort((x, y) => x - y).join(),
      ),
  );
  const phones = new Map();
  for (const person of people)
    for (const number of new Set(person.rows.map(phone).filter(Boolean)))
      phones.set(number, [...(phones.get(number) || []), person]);
  for (const sharing of phones.values())
    for (const person of sharing)
      for (const other of sharing) {
        const pair = [person.id, other.id].sort((x, y) => x - y).join();
        if (
          other !== person &&
          !apart.has(pair) &&
          !person.possible.includes(other.id)
        )
          person.possible.push(other.id);
      }
  return { people, personOf };
}
export function personIds(clients, id, links) {
  return groupClients(clients, links).personOf.get(id)?.ids || [id];
}
// Their latest choice for each email decides. Unsubscribing on one booking
// counts for every record with that email.
export function wantsNews(client, clients) {
  if (!client?.marketingConsent || client.unsubscribedAt) return false;
  return !clients.some(
    (other) =>
      email(other) === email(client) &&
      other.unsubscribedAt &&
      +new Date(other.unsubscribedAt) >= +new Date(client.consentAt || 0),
  );
}
