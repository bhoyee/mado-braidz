import { createApp } from './app.js';
import { parseEnv } from './config/env.js';
import { createLogger } from './config/logger.js';
const config = parseEnv();
const logger = createLogger(config);
const app = createApp({ config, logger });
const server = app.listen(config.PORT, () =>
  logger.info({ port: config.PORT }, 'Mado African Braids is listening'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => server.close(() => process.exit(0)));
