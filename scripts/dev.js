import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { parseEnv } from '../src/config/env.js';

const config = parseEnv();
if (config.NODE_ENV !== 'development')
  throw new Error('Use npm start and cron outside local development.');

// Do not start another email scheduler when an existing app owns this port.
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', () =>
    reject(
      new Error(
        `Port ${config.PORT} is already in use. Stop the existing development server before running npm run dev.`,
      ),
    ),
  );
  probe.listen(config.PORT, () => probe.close(resolve));
});

const server = spawn(process.execPath, ['--watch', 'src/server.js'], {
  stdio: 'inherit',
  windowsHide: true,
});
let job,
  timer,
  stopping = false;
function runJobs() {
  if (stopping || job) return;
  job = spawn(process.execPath, ['scripts/run-jobs.js'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  job.on('error', () =>
    console.error('Unable to start local notification jobs.'),
  );
  job.on('close', () => {
    job = null;
  });
}
function stop() {
  stopping = true;
  clearInterval(timer);
  job?.kill();
  server.kill();
}
server.on('error', () => {
  console.error('Unable to start the development server.');
  stop();
  process.exitCode = 1;
});
server.on('close', (code) => {
  stop();
  process.exitCode = code || 0;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
runJobs();
timer = setInterval(runJobs, 60_000);
