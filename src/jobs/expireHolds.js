import { DateTime } from 'luxon';
export async function expireHolds(repository, bookings, now = DateTime.utc()) {
  let expired = 0;
  for (const row of await repository.expiredHolds(now.toJSDate()))
    if (await bookings.releaseHold(row.id, 'expired', true)) expired++;
  return expired;
}
