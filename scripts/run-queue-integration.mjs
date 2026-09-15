import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const command = process.execPath;
const vitest = new URL('../node_modules/vitest/vitest.mjs', import.meta.url).pathname.slice(process.platform === 'win32' ? 1 : 0);
const env = {
  ...process.env,
  QUEUE_INTEGRATION: '1',
  SSE_REDIS_INTEGRATION: '1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent',
  DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL ?? 'postgresql://jobagent:jobagent-local@localhost:5432/jobagent',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
};

const redisUrl = new URL(env.REDIS_URL);
const endpointReachable = async (host, port) => await new Promise((resolve) => {
  const socket = net.createConnection({
    host,
    port,
  });
  const finish = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(1500, () => finish(false));
});

if (!(await endpointReachable(redisUrl.hostname, Number(redisUrl.port || 6379)))) {
  console.error('GATED: Redis integration requires a reachable Redis endpoint; no integration tests were run.');
  process.exit(2);
}

const redisProbeKey = `jobagent:integration:probe:${randomUUID()}`;
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1_500 });
let redisWritable = false;
try {
  await redis.connect();
  redisWritable = (await redis.set(redisProbeKey, 'ok', 'NX', 'EX', 5)) === 'OK';
} catch {
  redisWritable = false;
} finally {
  try { await redis.del(redisProbeKey); } catch { /* probe cleanup is best effort */ }
  redis.disconnect();
}
if (!redisWritable) {
  console.error('GATED: Redis integration requires a writable Redis endpoint; no integration tests were run.');
  process.exit(2);
}

const databaseUrl = new URL(env.DATABASE_URL);
if (!(await endpointReachable(databaseUrl.hostname, Number(databaseUrl.port || 5432)))) {
  console.error('GATED: Queue integration requires a reachable PostgreSQL endpoint; no integration tests were run.');
  process.exit(2);
}

const result = spawnSync(
  command,
  [vitest, 'run', 'apps/api/src/services/queue-worker.integration.test.ts', 'apps/api/src/services/sse-redis-bridge.integration.test.ts'],
  { stdio: 'inherit', env },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
