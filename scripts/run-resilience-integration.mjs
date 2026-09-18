import { spawnSync } from 'node:child_process';

const runners = [
  'run-postgres-restart-integration.mjs',
  'run-redis-outage-integration.mjs',
  'run-queue-integration.mjs',
];

for (const name of runners) {
  console.log(`\n=== ${name} ===`);
  const path = new URL(`./${name}`, import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
  const result = spawnSync(process.execPath, [path], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
