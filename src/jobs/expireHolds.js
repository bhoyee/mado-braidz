import { DateTime } from 'luxon';
export async function expireHolds(repository, bookings, now = DateTime.utc()) {
  let expired = 0;
  // Look slightly ahead so an unreviewed transfer is extended before its chair
  // could be offered to somebody else.
  for (const row of await repository.expiredHolds(
    now.plus({ minutes: 10 }).toJSDate(),
  ))
    if ((await bookings.expireHold(row.id)) === 'expired') expired++;
  for (const batch of await repository.expiredBatches(now.toJSDate()))
    await bookings.expirePaymentBatch(batch.id);
  return expired;
}
