import pino from 'pino';
import { createStream } from 'rotating-file-stream';
import { mkdirSync } from 'node:fs';
export function createLogger(config) {
  if (config.NODE_ENV === 'test') return pino({ level: 'silent' });
  mkdirSync(config.LOG_DIR, { recursive: true });
  return pino(
    {
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers.set-cookie',
        'password',
        'DATABASE_URL',
      ],
    },
    createStream('app.log', {
      path: config.LOG_DIR,
      interval: '1d',
      maxFiles: 14,
    }),
  );
}
