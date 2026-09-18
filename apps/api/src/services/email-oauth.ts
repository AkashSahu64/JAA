import { createHash } from 'node:crypto';
import { createEmailOAuthState, type EmailOAuthStateInput, consumeEmailOAuthState, resolveEmailOAuthStateOwner } from './email-oauth-state';
import { grantEmailConsent, type EmailProvider, validateApprovedEmailScopes } from './email-connections';
import { retrieveDurableCredential, storeDurableCredential } from './durable-credentials';
import { withTenant } from '@jobagent/database';

type OAuthProvider = Exclude<EmailProvider, 'IMAP'>;

const providerConfig: Record<OAuthProvider, { clientIdEnv: string; authorizationEndpoint: string; tokenEndpoint: string }> = {
  GMAIL: { clientIdEnv: 'GMAIL_OAUTH_CLIENT_ID', authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth', tokenEndpoint: 'https://oauth2.googleapis.com/token' },
  MICROSOFT_GRAPH: { clientIdEnv: 'MICROSOFT_GRAPH_OAUTH_CLIENT_ID', authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token' },
};

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function tokenText(value: unknown, name: string, max = 8_000): string {
  if (typeof value !== 'string' || !value || value.length > max || hasControlCharacters(value)) throw new Error(`OAuth token response ${name} is invalid`);
  return value;
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface OAuthTokenExchangeClient {
  postForm(endpoint: string, form: URLSearchParams): Promise<{ status: number; json(): Promise<unknown> }>;
}

const fetchOAuthClient: OAuthTokenExchangeClient = {
  postForm: async (endpoint, form) => fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }),
};

export async function createEmailOAuthAuthorization(input: EmailOAuthStateInput): Promise<{ authorizationUrl: string; stateId: string; state: string; expiresAt: Date }> {
  if (!input || typeof input !== 'object' || (input.provider !== 'GMAIL' && input.provider !== 'MICROSOFT_GRAPH')) throw new Error('OAuth provider is unsupported');
  const config = providerConfig[input.provider];
  validateApprovedEmailScopes(input.provider, input.scopes);
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (!clientId || clientId.length > 500 || hasControlCharacters(clientId)) throw new Error('OAuth client configuration is unavailable');
  const state = await createEmailOAuthState(input);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: state.redirectUri,
    response_type: 'code',
    state: state.state,
    code_challenge: pkceChallenge(state.codeVerifier),
    code_challenge_method: 'S256',
    scope: state.scopes.join(' '),
    ...(input.provider === 'GMAIL' ? { access_type: 'offline', prompt: 'consent' } : {}),
  });
  return { authorizationUrl: `${config.authorizationEndpoint}?${params.toString()}`, stateId: state.id, state: state.state, expiresAt: state.expiresAt };
}

export async function exchangeEmailOAuthCode(input: {
  userId?: string;
  state: string;
  code: string;
  now?: Date;
}, client: OAuthTokenExchangeClient = fetchOAuthClient) {
  if (!input || (input.userId !== undefined && (typeof input.userId !== 'string' || !input.userId.trim())) || typeof input.state !== 'string' || !input.state.trim()
    || typeof input.code !== 'string' || !input.code.trim() || input.code.length > 10_000 || hasControlCharacters(input.code)) {
    throw new Error('OAuth callback input is invalid');
  }
  const userId = input.userId?.trim() ?? await resolveEmailOAuthStateOwner(input.state, input.now);
  if (!userId) throw new Error('OAuth state is invalid, expired, or already consumed');
  const consumed = await consumeEmailOAuthState(userId, input.state, input.now);
  if (!consumed) throw new Error('OAuth state is invalid, expired, or already consumed');
  if (consumed.provider === 'IMAP') throw new Error('IMAP does not support OAuth token exchange');
  validateApprovedEmailScopes(consumed.provider, consumed.scopes);
  const config = providerConfig[consumed.provider];
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (!clientId || hasControlCharacters(clientId)) throw new Error('OAuth client configuration is unavailable');
  const response = await client.postForm(config.tokenEndpoint, new URLSearchParams({
    client_id: clientId, grant_type: 'authorization_code', code: input.code.trim(), redirect_uri: consumed.redirectUri,
    code_verifier: consumed.codeVerifier,
  }));
  if (!response || response.status < 200 || response.status >= 300) throw new Error('OAuth token exchange failed');
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OAuth token response is invalid');
  const token = payload as Record<string, unknown>;
  const accessToken = tokenText(token.access_token, 'access token');
  const refreshToken = token.refresh_token === undefined ? undefined : tokenText(token.refresh_token, 'refresh token');
  const tokenType = tokenText(token.token_type, 'token type', 100);
  const expiresIn = token.expires_in === undefined ? undefined : Number(token.expires_in);
  if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0 || expiresIn > 31_536_000)) throw new Error('OAuth token expiry is invalid');
  const issuedAt = input.now ?? new Date();
  const credential = await storeDurableCredential({
    userId,
    name: `email-oauth:${consumed.provider}:${consumed.id}`,
    value: JSON.stringify({ accessToken, refreshToken: refreshToken ?? null, tokenType, ...(expiresIn === undefined ? {} : { expiresAt: new Date(issuedAt.getTime() + expiresIn * 1_000).toISOString() }) }),
  });
  const connection = await grantEmailConsent({ userId, provider: consumed.provider, accountLabel: consumed.accountLabel, scopes: consumed.scopes, credentialRef: credential.id });
  return { connection, credential, provider: consumed.provider };
}

/** Refresh an expiring OAuth credential without exposing token material to callers. */
export async function refreshEmailOAuthCredential(input: {
  userId: string;
  connectionId: string;
  now?: Date;
}, client: OAuthTokenExchangeClient = fetchOAuthClient) {
  if (!input || typeof input.userId !== 'string' || !input.userId.trim() || hasControlCharacters(input.userId)
    || typeof input.connectionId !== 'string' || !input.connectionId.trim() || hasControlCharacters(input.connectionId)) {
    throw new Error('OAuth refresh input is invalid');
  }
  const connection = await withTenant(input.userId, async tx => {
    const found = await tx.emailConnection.findFirst({
      where: { id: input.connectionId, userId: input.userId, status: 'ACTIVE' },
      select: { id: true, provider: true, credentialRef: true },
    });
    if (!found?.credentialRef) return found ? { ...found, credentialName: null } : null;
    const credential = await tx.credentialRecord.findFirst({
      where: { id: found.credentialRef, userId: input.userId, revokedAt: null },
      select: { name: true, version: true },
    });
    return { ...found, credentialName: credential?.name ?? null, credentialVersion: credential?.version ?? undefined };
  });
  if (!connection || (connection.provider !== 'GMAIL' && connection.provider !== 'MICROSOFT_GRAPH') || !connection.credentialRef || !connection.credentialName) {
    throw new Error('Active OAuth email connection is unavailable');
  }
  const serialized = await retrieveDurableCredential(input.userId, connection.credentialRef);
  if (!serialized) throw new Error('OAuth credential is unavailable');
  let stored: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    stored = parsed as Record<string, unknown>;
  } catch {
    throw new Error('OAuth credential is malformed');
  }
  const refreshToken = stored.refreshToken;
  if (typeof refreshToken !== 'string' || !refreshToken || hasControlCharacters(refreshToken)) throw new Error('OAuth refresh token is unavailable');
  const config = providerConfig[connection.provider];
  const clientId = process.env[config.clientIdEnv]?.trim();
  if (!clientId || hasControlCharacters(clientId)) throw new Error('OAuth client configuration is unavailable');
  const response = await client.postForm(config.tokenEndpoint, new URLSearchParams({
    client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken,
  }));
  if (!response || response.status < 200 || response.status >= 300) throw new Error('OAuth token refresh failed');
  const payload = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OAuth token response is invalid');
  const token = payload as Record<string, unknown>;
  const accessToken = tokenText(token.access_token, 'access token');
  const tokenType = tokenText(token.token_type ?? stored.tokenType, 'token type', 100);
  const expiresIn = token.expires_in === undefined ? undefined : Number(token.expires_in);
  if (expiresIn !== undefined && (!Number.isFinite(expiresIn) || expiresIn < 0 || expiresIn > 31_536_000)) throw new Error('OAuth token expiry is invalid');
  const issuedAt = input.now ?? new Date();
  if (!(issuedAt instanceof Date) || !Number.isFinite(issuedAt.getTime())) throw new Error('OAuth refresh time is invalid');
  const credential = await storeDurableCredential({
    userId: input.userId,
    name: connection.credentialName,
    value: JSON.stringify({
      accessToken,
      refreshToken: typeof token.refresh_token === 'string' ? tokenText(token.refresh_token, 'refresh token') : refreshToken,
      tokenType,
      ...(expiresIn === undefined ? {} : { expiresAt: new Date(issuedAt.getTime() + expiresIn * 1_000).toISOString() }),
    }),
    expectedVersion: connection.credentialVersion,
  });
  return { connectionId: connection.id, provider: connection.provider, credential };
}
