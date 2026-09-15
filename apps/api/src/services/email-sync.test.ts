import { describe, expect, it, vi } from 'vitest';
import { syncEmailConnection, validateMailboxSyncPage, validateMailboxSyncTime } from './email-sync';

const message = { messageId: 'm-1', sender: 'jobs@example.test', subject: 'Application received', body: 'Thank you for applying', receivedAt: new Date('2026-09-14T00:00:00Z') };

describe('email sync boundary', () => {
  it.each([new Date('invalid'), new Date(Date.now() + 6 * 60 * 1_000), 'not-a-date', null])('rejects an invalid sync timestamp', value => {
    expect(() => validateMailboxSyncTime(value)).toThrow();
  });

  it('accepts a bounded page and opaque cursor', () => {
    expect(() => validateMailboxSyncPage({ messages: [message], nextCursor: 'opaque-2' })).not.toThrow();
  });

  it('rejects an unregistered provider before invoking mailbox transport', async () => {
    const listMessages = vi.fn();
    await expect(syncEmailConnection({ userId: 'user-1', connectionId: 'connection-1', connector: { provider: 'UNTRUSTED', listMessages } })).rejects.toThrow('Unsupported mailbox provider');
    expect(listMessages).not.toHaveBeenCalled();
  });

  it('fails closed for malformed sync identities without throwing TypeError', async () => {
    await expect(syncEmailConnection({ userId: 42 as never, connectionId: 'connection-1', connector: { provider: 'GMAIL', listMessages: vi.fn() } })).rejects.toThrow('identity');
    await expect(syncEmailConnection({ userId: 'user-1', connectionId: 'connection-1\n', connector: { provider: 'GMAIL', listMessages: vi.fn() } })).rejects.toThrow('identity');
    await expect(syncEmailConnection({ userId: 'user-1', connectionId: 'connection-1', correlationId: 'sync-1\n', connector: { provider: 'GMAIL', listMessages: vi.fn() } })).rejects.toThrow('correlation');
  });

  it.each([
    { messages: Array.from({ length: 101 }, (_, i) => ({ ...message, messageId: `m-${i}` })), nextCursor: null },
    { messages: [message], nextCursor: '\u0000hostile' },
    { messages: [{ ...message, receivedAt: new Date('invalid') }], nextCursor: null },
    { messages: [{ ...message, body: 'x'.repeat(2_000_001) }], nextCursor: null },
    { messages: [{ ...message, sender: 42 }], nextCursor: null },
    { messages: [{ ...message, subject: null }], nextCursor: null },
    { messages: [{ ...message, messageId: '   ' }], nextCursor: null },
    { messages: [{ ...message, messageId: 'm-1\nBcc: attacker@example.test' }], nextCursor: null },
    { messages: [{ ...message, subject: 'Application\r\nReceived' }], nextCursor: null },
    { messages: [{ ...message, applicationId: 'application-1\n' }], nextCursor: null },
  ])('rejects unsafe mailbox pages', (page) => {
    expect(() => validateMailboxSyncPage(page as never)).toThrow();
  });
});
