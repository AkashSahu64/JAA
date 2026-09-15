import { createHash } from 'node:crypto';
import { createEmailOAuthState, type EmailOAuthStateInput } from './email-oauth-state';
import { consumeEmailOAuthState } from './email-oauth-state';
import { grantEmailConsent, type EmailProvider } from './email-connections';
import { storeDurableCredential } from './durable-credentials';

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
  });
  return { authorizationUrl: `${config.authorizationEndpoint}?${params.toString()}`, stateId: state.id, state: state.state, expiresAt: state.expiresAt };
}

export async function exchangeEmailOAuthCode(input: {
  userId: string;
  state: string;
  code: string;
  now?: Date;
}, client: OAuthTokenExchangeClient = fetchOAuthClient) {
  if (!input || typeof input.userId !== 'string' || !input.userId.trim() || typeof input.state !== 'string' || !input.state.trim()
    || typeof input.code !== 'string' || !input.code.trim() || input.code.length > 10_000 || hasControlCharacters(input.code)) {
    throw new Error('OAuth callback input is invalid');
  }
  const consumed = await consumeEmailOAuthState(input.userId, input.state, input.now);
  if (!consumed) throw new Error('OAuth state is invalid, expired, or already consumed');
  if (consumed.provider === 'IMAP') throw new Error('IMAP does not support OAuth token exchange');
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
    userId: input.userId,
    name: `email-oauth:${consumed.provider}:${consumed.id}`,
    value: JSON.stringify({ accessToken, refreshToken: refreshToken ?? null, tokenType, ...(expiresIn === undefined ? {} : { expiresAt: new Date(issuedAt.getTime() + expiresIn * 1_000).toISOString() }) }),
  });
  const connection = await grantEmailConsent({ userId: input.userId, provider: consumed.provider, accountLabel: consumed.accountLabel, scopes: consumed.scopes, credentialRef: credential.id });
  return { connection, credential, provider: consumed.provider };
}
