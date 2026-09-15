import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn() }));
vi.mock('../routes/sse', () => ({
  broadcastToUser: mocks.broadcast,
  serializeSseData: (value: unknown) => {
    try {
      const serialized = JSON.stringify(value);
      return serialized && serialized.length <= 100_000 ? serialized : null;
    } catch {
      return null;
    }
  },
}));

import { closeSseRedisBridge, startSseRedisBridge } from './sse-redis-bridge';

const enabled = process.env.SSE_REDIS_INTEGRATION === '1' && Boolean(process.env.REDIS_URL);
const describeRedis = enabled ? describe : describe.skip;

describeRedis('SSE Redis bridge integration', () => {
  let publisher: Redis;

  beforeAll(() => {
    publisher = new Redis(process.env.REDIS_URL!);
    return startSseRedisBridge().ready;
  });

  afterAll(async () => {
    await closeSseRedisBridge();
    await publisher.quit();
  });

  it('delivers a notification published by another instance', async () => {
    await publisher.publish('jobagent:sse:notifications', JSON.stringify({
      origin: 'other-api-instance', userId: 'integration-user', id: 'integration-notification',
      type: 'notification', data: { title: 'Ready' },
    }));
    const startedAt = Date.now();
    while (mocks.broadcast.mock.calls.length === 0 && Date.now() - startedAt < 3_000) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(mocks.broadcast).toHaveBeenCalledWith('integration-user', expect.objectContaining({ id: 'integration-notification', type: 'notification' }));
  });
});
