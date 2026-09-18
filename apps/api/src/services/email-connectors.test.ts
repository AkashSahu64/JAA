import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  withTenant: vi.fn(),
  retrieveDurableCredential: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({ withTenant: mocks.withTenant }));
vi.mock('./durable-credentials', () => ({ retrieveDurableCredential: mocks.retrieveDurableCredential }));

import { createFetchMailboxClient, createGmailMailboxConnector, createMicrosoftGraphMailboxConnector } from './email-connectors';

function response(json: unknown, status = 200) { return { status, json: async () => json }; }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.withTenant.mockImplementation(async (_userId: string, operation: (tx: unknown) => Promise<unknown>) => operation({
    emailConnection: { findFirst: vi.fn().mockResolvedValue({ credentialRef: 'credential-1' }) },
  }));
  mocks.retrieveDurableCredential.mockResolvedValue(JSON.stringify({ accessToken: 'access-token', tokenType: 'Bearer' }));
});

describe('provider mailbox connectors', () => {
  it('requires a bounded provider request timeout', () => {
    expect(() => createFetchMailboxClient(999)).toThrow('timeout');
    expect(() => createFetchMailboxClient(120_001)).toThrow('timeout');
    expect(() => createFetchMailboxClient(15_000)).not.toThrow();
  });

  it('reads and normalizes a bounded Gmail page through the owner credential', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(response({ messages: [{ id: 'gmail-1' }], nextPageToken: 'next-1' }))
      .mockResolvedValueOnce(response({
        id: 'gmail-1',
        payload: { headers: [{ name: 'From', value: 'Recruiter <recruiter@example.test>' }, { name: 'Subject', value: 'Application received' }, { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 GMT' }], body: { data: Buffer.from('Thank you for applying').toString('base64url') },
        },
      }));
    const page = await createGmailMailboxConnector({ userId: 'user-1', client: { get } }).listMessages({ connectionId: 'connection-1', cursor: null, limit: 100 });
    expect(page).toMatchObject({ nextCursor: 'next-1', messages: [{ messageId: 'gmail-1', subject: 'Application received', body: 'Thank you for applying' }] });
    expect(get).toHaveBeenNthCalledWith(1, expect.stringContaining('maxResults=100'), 'access-token');
    expect(get).toHaveBeenNthCalledWith(2, expect.stringContaining('/messages/gmail-1?format=full'), 'access-token');
  });

  it('accepts opaque provider cursors up to the shared mailbox limit', async () => {
    const cursor = 'x'.repeat(300);
    const get = vi.fn().mockResolvedValue(response({ messages: [] }));
    await expect(createGmailMailboxConnector({ userId: 'user-1', client: { get } }).listMessages({ connectionId: 'connection-1', cursor, limit: 10 }))
      .resolves.toEqual({ messages: [], nextCursor: null });
    expect(get).toHaveBeenCalledWith(expect.stringContaining(`pageToken=${cursor}`), 'access-token');
  });

  it('normalizes Microsoft Graph messages and accepts only provider-owned next links', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=opaque';
    const get = vi.fn().mockResolvedValue(response({
      value: [{ id: 'graph-1', from: { emailAddress: { address: 'recruiter@example.test' } }, subject: 'Interview invitation', body: { content: 'Please schedule an interview', contentType: 'Text' }, receivedDateTime: '2026-09-15T10:00:00.000Z' }],
      '@odata.nextLink': next,
    }));
    const connector = createMicrosoftGraphMailboxConnector({ userId: 'user-1', client: { get } });
    const page = await connector.listMessages({ connectionId: 'connection-1', cursor: null, limit: 25 });
    expect(page).toMatchObject({ nextCursor: next, messages: [{ messageId: 'graph-1', sender: 'recruiter@example.test' }] });
    await connector.listMessages({ connectionId: 'connection-1', cursor: next, limit: 25 });
    expect(get).toHaveBeenLastCalledWith(next, 'access-token');
  });

  it('fails closed on an invalid Graph continuation URL or provider response', async () => {
    const connector = createMicrosoftGraphMailboxConnector({ userId: 'user-1', client: { get: vi.fn() } });
    await expect(connector.listMessages({ connectionId: 'connection-1', cursor: 'https://evil.example/messages', limit: 10 })).rejects.toThrow('cursor');
    const get = vi.fn().mockResolvedValue(response({ value: [{ id: 'graph-1' }] }));
    await expect(createMicrosoftGraphMailboxConnector({ userId: 'user-1', client: { get } }).listMessages({ connectionId: 'connection-1', cursor: null, limit: 10 })).rejects.toThrow('Mailbox sender is invalid');
  });

  it('rejects a Graph continuation URL that targets a non-standard port', async () => {
    const connector = createMicrosoftGraphMailboxConnector({ userId: 'user-1', client: { get: vi.fn() } });
    await expect(connector.listMessages({ connectionId: 'connection-1', cursor: 'https://graph.microsoft.com:8443/v1.0/me/messages?$skiptoken=opaque', limit: 10 }))
      .rejects.toThrow('cursor');
  });

  it('rejects malformed Gmail message identities without constructing a request path', async () => {
    const get = vi.fn().mockResolvedValue(response({ messages: [{ id: 42 }] }));
    await expect(createGmailMailboxConnector({ userId: 'user-1', client: { get } }).listMessages({ connectionId: 'connection-1', cursor: null, limit: 10 }))
      .rejects.toThrow('Message identity is invalid');
    expect(get).toHaveBeenCalledOnce();
  });

  it('refreshes once on an expired access token and retries the same provider request', async () => {
    const refresh = vi.fn().mockResolvedValue('refreshed-token');
    const get = vi.fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ value: [] }));
    const page = await createMicrosoftGraphMailboxConnector({ userId: 'user-1', client: { get }, refresh }).listMessages({ connectionId: 'connection-1', cursor: null, limit: 10 });
    expect(page).toEqual({ messages: [], nextCursor: null });
    expect(refresh).toHaveBeenCalledWith({ userId: 'user-1', connectionId: 'connection-1' });
    expect(get).toHaveBeenNthCalledWith(2, expect.stringContaining('graph.microsoft.com/v1.0/me/messages'), 'refreshed-token');
  });

  it('reuses the refreshed token for later Gmail message reads in the same page', async () => {
    const refresh = vi.fn().mockResolvedValue('refreshed-token');
    const get = vi.fn()
      .mockResolvedValueOnce(response({ messages: [{ id: 'gmail-1' }, { id: 'gmail-2' }] }))
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ id: 'gmail-1', payload: { headers: [{ name: 'From', value: 'a@example.test' }, { name: 'Subject', value: 'One' }, { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 GMT' }], body: { data: Buffer.from('one').toString('base64url') } } }))
      .mockResolvedValueOnce(response({ id: 'gmail-2', payload: { headers: [{ name: 'From', value: 'b@example.test' }, { name: 'Subject', value: 'Two' }, { name: 'Date', value: 'Tue, 15 Sep 2026 10:01:00 GMT' }], body: { data: Buffer.from('two').toString('base64url') } } }));
    await expect(createGmailMailboxConnector({ userId: 'user-1', client: { get }, refresh }).listMessages({ connectionId: 'connection-1', cursor: null, limit: 10 })).resolves.toMatchObject({ messages: [{ messageId: 'gmail-1' }, { messageId: 'gmail-2' }] });
    expect(refresh).toHaveBeenCalledOnce();
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining('/messages/gmail-2?format=full'), 'refreshed-token');
  });
});
