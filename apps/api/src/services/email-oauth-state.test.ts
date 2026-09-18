import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn(), serviceFindFirst: vi.fn() }));
vi.mock('@jobagent/database', () => ({ withTenant: async (_userId: string, operation: (tx: unknown) => unknown) => operation({ emailOAuthState: { create: mocks.create, findFirst: mocks.findFirst, updateMany: mocks.updateMany } }), withService: async (operation: (tx: unknown) => unknown) => operation({ emailOAuthState: { findFirst: mocks.serviceFindFirst } }) }));
vi.mock('@jobagent/security', () => ({ encrypt: (value: string) => `enc:${value}`, decrypt: (value: string) => value.replace(/^enc:/, '') }));

import { consumeEmailOAuthState, createEmailOAuthState, resolveEmailOAuthStateOwner } from './email-oauth-state';

describe('durable email OAuth state', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it('creates opaque state and encrypted PKCE verifier with bounded redirect/scopes', async () => {
    const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
    mocks.create.mockResolvedValue({ id: 'oauth-state-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', scopes: [gmailScope], expiresAt: new Date('2026-09-15T00:10:00Z') });
    const result = await createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', accountLabel: 'candidate@example.test', scopes: [gmailScope] });
    expect(result.state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', provider: 'GMAIL', stateHash: expect.stringMatching(/^[a-f0-9]{64}$/), encryptedCodeVerifier: `enc:${result.codeVerifier}` }) }));
  });

  it('consumes a live state once and decrypts only after the conditional update wins', async () => {
    const now = new Date('2026-09-15T00:05:00Z');
    mocks.findFirst.mockResolvedValue({ id: 'oauth-state-1', userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', accountLabel: 'candidate@example.test', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], encryptedCodeVerifier: 'enc:verifier-1' });
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
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: ['https://mail.google.com/'] })).rejects.toThrow('approved read-mail');
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://user:pass@app.example/callback', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('without credentials');
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback#fragment', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('without credentials');
  });

  it('allowlists OAuth redirect origins in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FRONTEND_URL', 'https://app.example/');
    const gmailScope = 'https://www.googleapis.com/auth/gmail.readonly';
    mocks.create.mockResolvedValue({ id: 'oauth-state-2', provider: 'GMAIL', redirectUri: 'https://app.example/callback', scopes: [gmailScope], expiresAt: new Date() });
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [gmailScope] })).resolves.toBeDefined();
    await expect(createEmailOAuthState({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://evil.example/callback', accountLabel: 'candidate@example.test', scopes: [gmailScope] })).rejects.toThrow('not allowlisted');
  });

  it('resolves a live opaque callback state to its owner without exposing state data', async () => {
    mocks.serviceFindFirst.mockResolvedValue({ userId: 'user-1', provider: 'GMAIL', accountLabel: 'candidate@example.test' });
    await expect(resolveEmailOAuthStateOwner('opaque-state', new Date('2026-09-15T00:05:00Z'))).resolves.toBe('user-1');
    expect(mocks.serviceFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ stateHash: expect.stringMatching(/^[a-f0-9]{64}$/), consumedAt: null }) }));
  });
});
