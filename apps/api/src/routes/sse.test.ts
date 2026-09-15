import { describe, expect, it } from 'vitest';
import { deduplicateReplayedEvents, hasSseCapacity, isSafeSseToken, MAX_SSE_CONNECTIONS_PER_USER, serializeSseData } from './sse';

describe('SSE payload boundary', () => {
  it('serializes bounded JSON data', () => {
    expect(serializeSseData({ event: 'notification', count: 1 })).toBe('{"event":"notification","count":1}');
  });

  it('rejects circular and oversized payloads', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(serializeSseData(circular)).toBeNull();
    expect(serializeSseData('x'.repeat(100_001))).toBeNull();
  });

  it('bounds live connections per tenant', () => {
    expect(hasSseCapacity(0)).toBe(true);
    expect(hasSseCapacity(MAX_SSE_CONNECTIONS_PER_USER)).toBe(false);
    expect(hasSseCapacity(-1)).toBe(false);
    expect(hasSseCapacity(2, 2)).toBe(false);
  });

  it('rejects protocol-header injection in event names and cursors', () => {
    expect(isSafeSseToken('notification')).toBe(true);
    expect(isSafeSseToken('notification\nid: forged')).toBe(false);
    expect(isSafeSseToken('')).toBe(false);
    expect(isSafeSseToken('x'.repeat(201))).toBe(false);
  });

  it('does not replay a live event already delivered by the durable replay', () => {
    const pending = deduplicateReplayedEvents(new Set(['notification-1']), [
      { id: 'notification-1', type: 'notification', data: { title: 'duplicate' } },
      { id: 'notification-2', type: 'notification', data: { title: 'new' } },
      { type: 'heartbeat', data: null },
    ]);
    expect(pending).toEqual([
      { id: 'notification-2', type: 'notification', data: { title: 'new' } },
      { type: 'heartbeat', data: null },
    ]);
  });

  it('coalesces duplicate identified live events while preserving unidentifiable events', () => {
    expect(deduplicateReplayedEvents(new Set(), [
      { id: 'notification-1', type: 'notification', data: 1 },
      { id: 'notification-1', type: 'notification', data: 1 },
      { type: 'notification', data: 2 },
    ])).toEqual([
      { id: 'notification-1', type: 'notification', data: 1 },
      { type: 'notification', data: 2 },
    ]);
  });
});
