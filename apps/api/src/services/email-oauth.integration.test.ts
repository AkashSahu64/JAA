import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { grantEmailConsent } from './email-connections';
import { refreshEmailOAuthCredential } from './email-oauth';
import { retrieveDurableCredential, storeDurableCredential } from './durable-credentials';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable OAuth refresh rotation', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const now = new Date('2026-09-16T00:00:00.000Z');
  const previousEncryptionKey = process.env.ENCRYPTION_KEY;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY ??= 'fixture-encryption-key-for-oauth-refresh-0123456789';
    process.env.GMAIL_OAUTH_CLIENT_ID = 'fixture-gmail-client';
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'OAuth Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other OAuth Tenant' },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previousEncryptionKey;
    await prisma.$disconnect();
  });

  it('refreshes an owner-bound credential, preserves identity, and persists the rotated secret', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:fixture',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'fixture@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    const result = await refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async (_endpoint, form) => {
        expect(form.get('grant_type')).toBe('refresh_token');
        expect(form.get('refresh_token')).toBe('old-refresh');
        return { status: 200, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer', expires_in: 3600 }) };
      },
    });

    expect(result).toMatchObject({ connectionId: connection.id, provider: 'GMAIL', credential: { id: credential.id, version: 2 } });
    expect(await retrieveDurableCredential(userId, credential.id)).toBe(JSON.stringify({
      accessToken: 'new-access', refreshToken: 'new-refresh', tokenType: 'Bearer', expiresAt: '2026-09-16T01:00:00.000Z',
    }));
    await expect(prisma.auditLog.count({ where: { userId, resourceId: credential.id, action: 'CREDENTIAL_STORED' } })).resolves.toBe(2);

    const crossTenantClient = { postForm: async () => { throw new Error('cross-tenant provider call must not occur'); } };
    await expect(refreshEmailOAuthCredential({ userId: otherUserId, connectionId: connection.id, now }, crossTenantClient)).rejects.toThrow('connection is unavailable');
  });

  it('fails one concurrent refresh closed instead of overwriting a newer rotation', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:concurrent',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({ userId, provider: 'GMAIL', accountLabel: 'concurrent@example.invalid', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], credentialRef: credential.id });
    let calls = 0;
    let release!: () => void;
    const bothCalled = new Promise<void>(resolve => { release = resolve; });
    const client = {
      postForm: async (_endpoint: string, form: URLSearchParams) => {
        expect(form.get('refresh_token')).toBe('old-refresh');
        calls += 1;
        if (calls === 2) release();
        await bothCalled;
        return { status: 200, json: async () => ({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }) };
      },
    };
    const results = await Promise.allSettled([
      refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, client),
      refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, client),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected').map(result => result.reason)).toHaveLength(1);
    expect(String(results.find(result => result.status === 'rejected')?.reason)).toContain('Credential changed during refresh');
    expect(await retrieveDurableCredential(userId, credential.id)).toContain('rotated-refresh');
  });

  it('rejects refresh for a revoked or inactive email connection', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:revoked-conn',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'revoked-conn@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });
    await prisma.emailConnection.update({ where: { id: connection.id }, data: { status: 'REVOKED', revokedAt: new Date(), credentialRef: null } });

    await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async () => { throw new Error('provider call must not occur'); },
    })).rejects.toThrow('connection is unavailable');
  });

  it('rejects refresh for a non-OAuth provider (IMAP)', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:IMAP:imap-conn',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'IMAP',
      accountLabel: 'imap-conn@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async () => { throw new Error('provider call must not occur'); },
    })).rejects.toThrow('connection is unavailable');
  });

  it('fails when no client configuration is set for the provider', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:MICROSOFT_GRAPH:missing-client',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'MICROSOFT_GRAPH',
      accountLabel: 'missing-client@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    const saved = process.env.MICROSOFT_GRAPH_OAUTH_CLIENT_ID;
    delete process.env.MICROSOFT_GRAPH_OAUTH_CLIENT_ID;
    try {
      await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
        postForm: async () => { throw new Error('provider call must not occur'); },
      })).rejects.toThrow('configuration is unavailable');
    } finally {
      if (saved !== undefined) process.env.MICROSOFT_GRAPH_OAUTH_CLIENT_ID = saved;
    }
  });

  it('fails closed when the stored credential cannot be parsed', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:malformed-credential',
      value: '{ this is not valid json }',
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'malformed-credential@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async () => { throw new Error('provider call must not occur'); },
    })).rejects.toThrow('credential is malformed');
  });

  it('fails closed when the stored credential lacks a refresh token', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:no-refresh-token',
      value: JSON.stringify({ accessToken: 'old-access', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'no-refresh-token@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async () => { throw new Error('provider call must not occur'); },
    })).rejects.toThrow('refresh token is unavailable');
  });

  it('fails closed when the provider refresh request errors', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:provider-error',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'provider-error@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    await expect(refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async () => ({ status: 500, json: async () => ({ error: 'server_error' }) }),
    })).rejects.toThrow('token refresh failed');
  });

  it('validates refresh input before touching the database or provider', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:validation-input',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'validation-input@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    const client = { postForm: async () => { throw new Error('provider call must not occur'); } };
    await expect(refreshEmailOAuthCredential({ userId: 'user\x00with-null', connectionId: connection.id, now }, client)).rejects.toThrow('refresh input is invalid');
    await expect(refreshEmailOAuthCredential({ userId, connectionId: 'conn\nwith-control-chars', now }, client)).rejects.toThrow('refresh input is invalid');
    await expect(refreshEmailOAuthCredential({ userId: '', connectionId: connection.id, now }, client)).rejects.toThrow('refresh input is invalid');
  });

  it('retains the existing refresh token when the provider omits a new one', async () => {
    const credential = await storeDurableCredential({
      userId,
      name: 'email-oauth:GMAIL:no-rotated-refresh',
      value: JSON.stringify({ accessToken: 'old-access', refreshToken: 'old-refresh', tokenType: 'Bearer' }),
    });
    const connection = await grantEmailConsent({
      userId,
      provider: 'GMAIL',
      accountLabel: 'no-rotated-refresh@example.invalid',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      credentialRef: credential.id,
    });

    const result = await refreshEmailOAuthCredential({ userId, connectionId: connection.id, now }, {
      postForm: async (_endpoint, form) => {
        expect(form.get('refresh_token')).toBe('old-refresh');
        return { status: 200, json: async () => ({ access_token: 'new-access', token_type: 'Bearer', expires_in: 7200 }) };
      },
    });

    expect(result).toMatchObject({ connectionId: connection.id, provider: 'GMAIL', credential: { id: credential.id, version: 2 } });
    expect(await retrieveDurableCredential(userId, credential.id)).toContain('old-refresh');
  });
});
