import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { encrypt, decrypt } from '@jobagent/security';
import { withTenant } from '@jobagent/database';
import { EMAIL_PROVIDERS, EmailProvider } from './email-connections';

const STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_REDIRECT_URI_LENGTH = 2_000;

export interface EmailOAuthStateInput {
  userId: string;
  provider: EmailProvider;
  redirectUri: string;
  accountLabel: string;
  scopes: string[];
}

export interface ConsumedEmailOAuthState {
  id: string;
  userId: string;
  provider: EmailProvider;
  redirectUri: string;
  accountLabel: string;
  scopes: string[];
  codeVerifier: string;
}

function opaqueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeText(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`${name} is invalid`);
  return value.trim();
}

function validateInput(input: EmailOAuthStateInput): void {
  if (!input || typeof input !== 'object') throw new Error('OAuth input is invalid');
  safeText(input.userId, 200, 'OAuth owner');
  if (!EMAIL_PROVIDERS.includes(input.provider)) throw new Error('Unsupported email provider');
  const redirect = safeText(input.redirectUri, MAX_REDIRECT_URI_LENGTH, 'OAuth redirect URI');
  safeText(input.accountLabel, 320, 'OAuth account label');
  let url: URL;
  try { url = new URL(redirect); } catch { throw new Error('OAuth redirect URI is invalid'); }
  if ((url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') || url.username || url.password || url.hash) throw new Error('OAuth redirect URI must use HTTPS without credentials or fragments');
  if (!Array.isArray(input.scopes) || input.scopes.length > 50 || input.scopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 200 || Array.from(scope).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new Error('OAuth scopes are invalid');
}

export async function createEmailOAuthState(input: EmailOAuthStateInput) {
  validateInput(input);
  const state = randomBytes(32).toString('base64url');
  const codeVerifier = randomBytes(32).toString('base64url');
  const scopes = input.scopes.map(scope => scope.trim());
  const record = await withTenant(input.userId, async tx => tx.emailOAuthState.create({ data: { id: randomUUID(), userId: input.userId, provider: input.provider, stateHash: opaqueHash(state), encryptedCodeVerifier: encrypt(codeVerifier), redirectUri: input.redirectUri.trim(), accountLabel: input.accountLabel.trim(), scopes, expiresAt: new Date(Date.now() + STATE_TTL_MS) }, select: { id: true, provider: true, redirectUri: true, accountLabel: true, scopes: true, expiresAt: true } }));
  return { ...record, state, codeVerifier };
}

export async function consumeEmailOAuthState(userId: string, state: string, now = new Date()): Promise<ConsumedEmailOAuthState | null> {
  const owner = safeText(userId, 200, 'OAuth owner');
  const rawState = safeText(state, 512, 'OAuth state');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('OAuth state time is invalid');
  return withTenant(owner, async tx => {
    const record = await tx.emailOAuthState.findFirst({ where: { userId: owner, stateHash: opaqueHash(rawState), consumedAt: null, expiresAt: { gt: now } }, select: { id: true, userId: true, provider: true, redirectUri: true, accountLabel: true, scopes: true, encryptedCodeVerifier: true } });
    // States created before account binding (or malformed legacy rows) must
    // never reach consent activation without an explicit mailbox identity.
    if (!record || !EMAIL_PROVIDERS.includes(record.provider as EmailProvider) || !record.accountLabel?.trim()) return null;
    const consumed = await tx.emailOAuthState.updateMany({ where: { id: record.id, userId: owner, consumedAt: null, expiresAt: { gt: now } }, data: { consumedAt: now } });
    if (consumed.count !== 1) return null;
    return { id: record.id, userId: record.userId, provider: record.provider as EmailProvider, redirectUri: record.redirectUri, accountLabel: record.accountLabel, scopes: record.scopes, codeVerifier: decrypt(record.encryptedCodeVerifier) };
  });
}
