import { randomUUID } from 'node:crypto';
import Redis, { type RedisOptions } from 'ioredis';
import { redisConnection } from '@jobagent/queue';
import { broadcastToUser, serializeSseData } from '../routes/sse';

const configuredChannel = process.env.SSE_REDIS_CHANNEL?.trim();
const CHANNEL = configuredChannel && configuredChannel.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(configuredChannel)
  ? configuredChannel
  : 'jobagent:sse:notifications';
const MAX_MESSAGE_BYTES = 100_000;
const MAX_ID_LENGTH = 200;
const MAX_USER_ID_LENGTH = 200;
const instanceId = randomUUID();
let publisher: Redis | undefined;
let subscriber: Redis | undefined;
let bridgeStarted = false;
let bridgeReady: Promise<void> | undefined;

type RedisLiveEvent = { origin: string; userId: string; id?: string; type: string; data: unknown };

function redisOptions(): RedisOptions {
  return redisConnection() as RedisOptions;
}

function observeRedisErrors(connection: Redis): Redis {
  connection.on('error', () => undefined);
  return connection;
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

export function parseRedisLiveEvent(raw: string): RedisLiveEvent | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  try {
    const value = JSON.parse(raw) as Partial<RedisLiveEvent>;
    if (!value || typeof value !== 'object' || !validText(value.origin, MAX_ID_LENGTH)
      || !validText(value.userId, MAX_USER_ID_LENGTH) || !validText(value.type, 100)
      || serializeSseData(value.data) === null) return null;
    if (value.id !== undefined && !validText(value.id, MAX_ID_LENGTH)) return null;
    return { origin: value.origin, userId: value.userId, type: value.type, data: value.data, ...(value.id ? { id: value.id } : {}) };
  } catch {
    return null;
  }
}

export function startSseRedisBridge(): { close: () => Promise<void>; ready: Promise<void> } {
  if (bridgeStarted) return { close: closeSseRedisBridge, ready: bridgeReady ?? Promise.resolve() };
  bridgeStarted = true;
  const connection = observeRedisErrors(new Redis(redisOptions()));
  subscriber = connection;
  let resolveBridgeReady: () => void = () => undefined;
  bridgeReady = new Promise<void>(resolve => { resolveBridgeReady = resolve; });
  let subscribing = false;
  const subscribe = () => {
    if (subscriber !== connection || connection.status === 'end' || subscribing) return;
    subscribing = true;
    void connection.subscribe(CHANNEL).then(() => {
      resolveBridgeReady();
    }).catch(() => undefined).finally(() => { subscribing = false; });
  };
  connection.on('ready', subscribe);
  subscribe();
  connection.on('message', (_channel, raw) => {
    const event = parseRedisLiveEvent(raw);
    if (event && event.origin !== instanceId) broadcastToUser(event.userId, event);
  });
  return { close: closeSseRedisBridge, ready: bridgeReady };
}

export async function publishSseEvent(event: Omit<RedisLiveEvent, 'origin'>): Promise<void> {
  let candidate: RedisLiveEvent | null;
  try {
    candidate = parseRedisLiveEvent(JSON.stringify({ ...event, origin: instanceId }));
  } catch {
    return;
  }
  if (!candidate) return;
  publisher ??= observeRedisErrors(new Redis(redisOptions()));
  await publisher.publish(CHANNEL, JSON.stringify(candidate));
}

export async function closeSseRedisBridge(): Promise<void> {
  const connections = [publisher, subscriber].filter((connection): connection is Redis => Boolean(connection));
  publisher = undefined;
  subscriber = undefined;
  bridgeStarted = false;
  bridgeReady = undefined;
  await Promise.all(connections.map(connection => connection.quit().catch(() => connection.disconnect())));
}
