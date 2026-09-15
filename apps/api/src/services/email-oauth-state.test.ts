import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() }));
vi.mock('@jobagent/database', () => ({ withTenant: async (_userId: string, operation: (tx: unknown) => unknown) => operation({ emailOAuthState: { create: mocks.create, findFirst: mocks.findFirst, updateMany: mocks.updateMany } }) }));
vi.mock('@jobagent/security', () => ({ encrypt: (value: string) => `enc:${value}`, decrypt: (value: string) => value.replace(/^enc:/, '') }));

import { consumeEmailOAuthState, createEmailOAuthState } from './email-oauth-state';

describe('durable email OAuth state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates opaque state and encrypted PKCE verifier with bounded redirect/scopes', async () => {
    mocks.create.mockResolvedValue({ id: 'oauth-state-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', scopes: ['readonly'], expiresAt: new Date('2026-09-15T00:10:00Z') });
    const result = await createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', accountLabel: 'candidate@example.test', scopes: ['readonly'] });
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', provider: 'GMAIL', stateHash: expect.stringMatching(/^[a-f0-9]{64}$/), encryptedCodeVerifier: `enc:${result.codeVerifier}` }) }));
  });

  it('consumes a live state once and decrypts only after the conditional update wins', async () => {
    const now = new Date('2026-09-15T00:05:00Z');
    mocks.findFirst.mockResolvedValue({ id: 'oauth-state-1', userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', accountLabel: 'candidate@example.test', scopes: ['readonly'], encryptedCodeVerifier: 'enc:verifier-1' });
    mocks.updateMany.mockResolvedValue({ count: 1 });
    await expect(consumeEmailOAuthState('user-1', 'state-value', now)).resolves.toMatchObject({ id: 'oauth-state-1', provider: 'GMAIL', codeVerifier: 'verifier-1' });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'oauth-state-1', userId: 'user-1', consumedAt: null }) }));
  });

  it('fails closed for expired, raced, unsupported, or unsafe state', async () => {
    mocks.findFirst.mockResolvedValue(null);
    await expect(consumeEmailOAuthState('user-1', 'state-value', new Date())).resolves.toBeNull();
    await expect(consumeEmailOAuthState('user-1', 'state-value\n')).rejects.toThrow('OAuth state is invalid');
    mocks.findFirst.mockResolvedValue({ id: 'oauth-state-1', userId: 'user-1', provider: 'EVIL', redirectUri: 'https://app.example/callback', scopes: [], encryptedCodeVerifier: 'enc:verifier-1' });
    await expect(consumeEmailOAuthState('user-1', 'state-value')).resolves.toBeNull();
    mocks.findFirst.mockResolvedValue({ id: 'oauth-state-1', userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', scopes: [], encryptedCodeVerifier: 'enc:verifier-1' });
    await expect(consumeEmailOAuthState('user-1', 'state-value')).resolves.toBeNull();
    mocks.findFirst.mockResolvedValue({ id: 'oauth-state-1', userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [], encryptedCodeVerifier: 'enc:verifier-1' });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await expect(consumeEmailOAuthState('user-1', 'state-value')).resolves.toBeNull();
  });

  it('rejects malformed input and credential-bearing or fragment redirects', async () => {
    await expect(createEmailOAuthState(undefined as never)).rejects.toThrow('OAuth input is invalid');
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://user:pass@app.example/callback', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('without credentials');
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback#fragment', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('without credentials');
  });
});
