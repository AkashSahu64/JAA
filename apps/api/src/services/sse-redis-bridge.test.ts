import { describe, expect, it } from 'vitest';
import { parseRedisLiveEvent } from './sse-redis-bridge';

describe('SSE Redis bridge envelope boundary', () => {
  it('accepts a bounded tenant-owned live event', () => {
    expect(parseRedisLiveEvent(JSON.stringify({ origin: 'api-a', userId: 'user-1', id: 'notification-1', type: 'notification', data: { title: 'Ready' } }))).toEqual({
      origin: 'api-a', userId: 'user-1', id: 'notification-1', type: 'notification', data: { title: 'Ready' },
    });
  });

  it('rejects malformed, oversized, and missing-owner envelopes', () => {
    expect(parseRedisLiveEvent('{not-json')).toBeNull();
    expect(parseRedisLiveEvent(JSON.stringify({ origin: 'api-a', userId: '', type: 'notification', data: {} }))).toBeNull();
    expect(parseRedisLiveEvent(JSON.stringify({ origin: 'api-a', userId: 'user-1', type: 'notification', data: {}, id: 'x'.repeat(201) }))).toBeNull();
    expect(parseRedisLiveEvent('x'.repeat(100_001))).toBeNull();
  });

  it('rejects missing event data', () => {
    expect(parseRedisLiveEvent(JSON.stringify({ origin: 'api-a', userId: 'user-1', type: 'notification' }))).toBeNull();
  });
});
