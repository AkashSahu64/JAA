import type { ConnectionOptions } from 'bullmq';

export interface QueueConnectionConfig {
  url?: string;
  prefix?: string;
}

export function redisConnection(config: QueueConnectionConfig = {}): ConnectionOptions {
  const url = new URL(config.url ?? process.env.REDIS_URL ?? 'redis://localhost:6379');
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    throw new Error('REDIS_URL must use redis:// or rediss://');
  }
  const database = url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0;
  if (!Number.isSafeInteger(database) || database < 0) throw new Error('REDIS_URL database must be a non-negative integer');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: database,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}
