import { beforeEach, describe, expect, it, vi } from 'vitest';

const createState = vi.hoisted(() => vi.fn());
const consumeState = vi.hoisted(() => vi.fn());
const storeCredential = vi.hoisted(() => vi.fn());
const grantConsent = vi.hoisted(() => vi.fn());
vi.mock('./email-oauth-state', () => ({ createEmailOAuthState: createState, consumeEmailOAuthState: consumeState }));
vi.mock('./durable-credentials', () => ({ storeDurableCredential: storeCredential }));
vi.mock('./email-connections', () => ({ grantEmailConsent: grantConsent }));

import { createEmailOAuthAuthorization, exchangeEmailOAuthCode } from './email-oauth';

describe('email OAuth authorization boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('GMAIL_OAUTH_CLIENT_ID', 'gmail-client');
    vi.stubEnv('MICROSOFT_GRAPH_OAUTH_CLIENT_ID', 'graph-client');
    consumeState.mockReset();
    storeCredential.mockReset();
    grantConsent.mockReset();
  });

  it('builds a Gmail authorization URL with S256 PKCE and durable state', async () => {
    createState.mockResolvedValue({ id: 'state-1', state: 'opaque-state', codeVerifier: 'verifier-value', redirectUri: 'https://app.example/oauth/callback', scopes: ['https://mail.google.com/'], expiresAt: new Date('2026-09-15T00:10:00Z') });
    const result = await createEmailOAuthAuthorization({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/oauth/callback', accountLabel: 'candidate@example.test', scopes: ['https://mail.google.com/'] });
    const url = new URL(result.authorizationUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('state')).toBe('opaque-state');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses the Microsoft authorization endpoint and rejects IMAP or missing client configuration', async () => {
    createState.mockResolvedValue({ id: 'state-2', state: 'opaque-state', codeVerifier: 'verifier-value', redirectUri: 'http://localhost:5173/callback', scopes: ['Mail.Read'], expiresAt: new Date() });
    await expect(createEmailOAuthAuthorization({ userId: 'user-1', provider: 'MICROSOFT_GRAPH', redirectUri: 'http://localhost:5173/callback', accountLabel: 'candidate@example.test', scopes: ['Mail.Read'] })).resolves.toMatchObject({ authorizationUrl: expect.stringContaining('login.microsoftonline.com') });
    await expect(createEmailOAuthAuthorization({ userId: 'user-1', provider: 'IMAP', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('provider is unsupported');
    vi.stubEnv('GMAIL_OAUTH_CLIENT_ID', '');
    await expect(createEmailOAuthAuthorization({ userId: 'user-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [] })).rejects.toThrow('configuration is unavailable');
  });

  it('exchanges a consumed code, stores tokens durably, and activates owner consent', async () => {
    consumeState.mockResolvedValue({ id: 'state-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: ['readonly'], codeVerifier: 'verifier-value' });
    storeCredential.mockResolvedValue({ id: 'credential-1', version: 1 });
    grantConsent.mockResolvedValue({ id: 'connection-1', provider: 'GMAIL' });
    const postForm = vi.fn(async (_endpoint: string, form: URLSearchParams) => {
      expect(form.get('code_verifier')).toBe('verifier-value');
      expect(form.get('code')).toBe('auth-code');
      return { status: 200, json: async () => ({ access_token: 'access-token', refresh_token: 'refresh-token', token_type: 'Bearer', expires_in: 3_600 }) };
    });
    const result = await exchangeEmailOAuthCode({ userId: 'user-1', state: 'opaque-state', code: 'auth-code' }, { postForm });
    expect(storeCredential).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', value: expect.stringContaining('access-token') }));
    expect(grantConsent).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: 'credential-1', accountLabel: 'candidate@example.test', scopes: ['readonly'] }));
    expect(result).toMatchObject({ provider: 'GMAIL', connection: { id: 'connection-1' } });
  });

  it('fails closed on an invalid or failed token response without activating consent', async () => {
    consumeState.mockResolvedValue({ id: 'state-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [], codeVerifier: 'verifier-value' });
    await expect(exchangeEmailOAuthCode({ userId: 'user-1', state: 'opaque-state', code: 'auth-code' }, { postForm: vi.fn(async () => ({ status: 400, json: async () => ({}) })) })).rejects.toThrow('token exchange failed');
    expect(storeCredential).not.toHaveBeenCalled();
    expect(grantConsent).not.toHaveBeenCalled();
  });

  it('rejects malformed provider token fields before durable credential or consent writes', async () => {
    consumeState.mockResolvedValue({ id: 'state-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [], codeVerifier: 'verifier-value' });
    const postForm = vi.fn(async () => ({ status: 200, json: async () => ({ access_token: 'access\n-token', token_type: 'Bearer' }) }));
    await expect(exchangeEmailOAuthCode({ userId: 'user-1', state: 'opaque-state', code: 'auth-code' }, { postForm })).rejects.toThrow('access token is invalid');
    expect(storeCredential).not.toHaveBeenCalled();
    expect(grantConsent).not.toHaveBeenCalled();
  });

  it('uses the trusted callback time when calculating token expiry', async () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    consumeState.mockResolvedValue({ id: 'state-1', provider: 'GMAIL', redirectUri: 'https://app.example/callback', accountLabel: 'candidate@example.test', scopes: [], codeVerifier: 'verifier-value' });
    storeCredential.mockResolvedValue({ id: 'credential-1', version: 1 });
    grantConsent.mockResolvedValue({ id: 'connection-1', provider: 'GMAIL' });
    await exchangeEmailOAuthCode({ userId: 'user-1', state: 'opaque-state', code: 'auth-code', now }, { postForm: vi.fn(async () => ({ status: 200, json: async () => ({ access_token: 'access-token', token_type: 'Bearer', expires_in: 60 }) })) });
    expect(storeCredential).toHaveBeenCalledWith(expect.objectContaining({ value: expect.stringContaining('2026-09-15T00:01:00.000Z') }));
  });
});
