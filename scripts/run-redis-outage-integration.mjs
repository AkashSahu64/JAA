import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const command = process.execPath;
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const dockerBin = 'C:\\Program Files\\Docker\\Docker\\resources\\bin';
const containerName = 'jobagent-goal5-redis-outage';
const redisPort = '6380';
const docker = process.env.DOCKER_BIN ?? `${dockerBin}\\docker.exe`;
const dockerCheck = spawnSync(docker, ['info'], { stdio: 'ignore' });
if (dockerCheck.error || dockerCheck.status !== 0) {
  console.error('GATED: Redis outage integration requires a reachable Docker daemon; no integration tests were run.');
  process.exit(2);
}
const remove = spawnSync(docker, ['rm', '-f', containerName], { stdio: 'ignore' });
if (remove.error && remove.error.code !== 'ENOENT') throw remove.error;
const start = spawnSync(docker, [
  'run', '-d', '--name', containerName, '-p', `${redisPort}:6379`,
  'redis:8.2.1-alpine', 'redis-server', '--appendonly', 'yes', '--appendfsync', 'everysec',
], { stdio: 'inherit' });
if (start.error) throw start.error;
if (start.status !== 0) process.exit(start.status ?? 1);

const env = {
  ...process.env,
  REDIS_OUTAGE_INTEGRATION: '1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent',
  DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent',
  REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  REDIS_OUTAGE_PORT: redisPort,
  DOCKER_BIN: docker,
  REDIS_OUTAGE_TOKEN: randomUUID(),
};
env.PATH = process.platform === 'win32' ? `${dockerBin};${env.PATH ?? ''}` : env.PATH;
let exitCode = 1;
try {
  const result = spawnSync(
    command,
    [vitest, 'run', 'apps/api/src/services/redis-outage.integration.test.ts'],
    { stdio: 'inherit', env },
  );
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  spawnSync(docker, ['rm', '-f', containerName], { stdio: 'ignore' });
}
process.exit(exitCode);
