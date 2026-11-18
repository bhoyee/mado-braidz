import { parseEnv } from '../src/config/env.js';
import { createDatabase } from '../src/db/index.js';
import { createBookingRepository } from '../src/services/bookingRepository.js';
import { createBookingService } from '../src/services/bookingService.js';
import {
  createStripeProvider,
  createPaymentService,
} from '../src/services/paymentService.js';
import { expireHolds } from '../src/jobs/expireHolds.js';
import { createNotificationRepository } from '../src/services/notificationRepository.js';
import { createNotificationService } from '../src/services/notificationService.js';
const config = parseEnv(),
  { db, pool } = createDatabase(config.DATABASE_URL);
const connection = await pool.getConnection();
try {
  const [[result]] = await connection.query(
    "SELECT GET_LOCK('jobs',0) AS acquired",
  );
  if (result.acquired !== 1) console.log('Another job run is active; skipped');
  else {
    const repository = createBookingRepository(db),
      bookings = createBookingService(repository);
    const expired = await expireHolds(repository, bookings);
    await createPaymentService(
      repository,
      createStripeProvider(config),
      config,
    ).runRefunds();
    const notifications = await createNotificationService(
      createNotificationRepository(db),
      config,
    ).run();
    console.log(
      `Email jobs: ${notifications.sent} sent, ${notifications.failed} need retry or review`,
    );
    console.log(
      `Expired ${expired} unpaid holds; pending Stripe refunds checked`,
    );
  }
} finally {
  await connection.query("SELECT RELEASE_LOCK('jobs')");
  connection.release();
  await pool.end();
}
