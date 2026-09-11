import { spawnSync } from 'node:child_process';

const command = process.execPath;
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const env = {
  ...process.env,
  QUEUE_INTEGRATION: '1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
};
const result = spawnSync(
  command,
  [vitest, 'run', 'apps/api/src/services/queue-worker.integration.test.ts'],
  { stdio: 'inherit', env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
