import { withTenant } from '@jobagent/database';
import { retrieveDurableCredential } from './durable-credentials';
import { refreshEmailOAuthCredential } from './email-oauth';
import type { MailboxConnector, MailboxPage, MailboxMessage } from './email-sync';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH_API = 'https://graph.microsoft.com/v1.0/me/messages';
const MAX_MESSAGE_BYTES = 2_000_000;
const DEFAULT_MAILBOX_TIMEOUT_MS = 15_000;

export interface MailboxHttpClient {
  get(url: string, accessToken: string): Promise<{ status: number; json(): Promise<unknown> }>;
}

export type RefreshMailboxAccessToken = (input: { userId: string; connectionId: string }) => Promise<string>;

export function createFetchMailboxClient(timeoutMs = DEFAULT_MAILBOX_TIMEOUT_MS): MailboxHttpClient {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error('Mailbox timeout must be between one and 120 seconds');
  return {
    get: async (url, accessToken) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

const fetchMailboxClient = createFetchMailboxClient();

function boundedIdentity(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error(`${name} is required and bounded`);
  }
  return value.trim();
}

function boundedCursor(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512
    || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Mailbox cursor is invalid');
  }
  return value.trim();
}

function parseCredential(serialized: string): string {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { throw new Error('Mailbox credential is malformed'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mailbox credential is malformed');
  const accessToken = (value as Record<string, unknown>).accessToken;
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8_000
    || Array.from(accessToken).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Mailbox access token is unavailable');
  }
  return accessToken;
}

async function accessTokenFor(userId: string, connectionId: string, provider: 'GMAIL' | 'MICROSOFT_GRAPH'): Promise<string> {
  const connection = await withTenant(userId, async tx => tx.emailConnection.findFirst({
    where: { id: connectionId, userId, provider, status: 'ACTIVE' },
    select: { credentialRef: true },
  }));
  if (!connection?.credentialRef) throw new Error('Active mailbox credential is unavailable');
  const serialized = await retrieveDurableCredential(userId, connection.credentialRef);
  if (!serialized) throw new Error('Active mailbox credential is unavailable');
  return parseCredential(serialized);
}

async function getJson(client: MailboxHttpClient, url: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await client.get(url, accessToken);
  if (!response || response.status === 401) throw new MailboxUnauthorizedError();
  if (response.status < 200 || response.status >= 300) throw new Error('Mailbox provider request failed');
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mailbox provider response is invalid');
  return value as Record<string, unknown>;
}

class MailboxUnauthorizedError extends Error {
  constructor() { super('Mailbox access token expired'); this.name = 'MailboxUnauthorizedError'; }
}

async function getWithOneRefresh(
  client: MailboxHttpClient,
  url: string,
  userId: string,
  connectionId: string,
  accessToken: string,
  refresh: RefreshMailboxAccessToken,
): Promise<{ body: Record<string, unknown>; accessToken: string }> {
  try { return { body: await getJson(client, url, accessToken), accessToken }; } catch (error) {
    if (!(error instanceof MailboxUnauthorizedError)) throw error;
    const refreshedToken = await refresh({ userId, connectionId });
    return { body: await getJson(client, url, refreshedToken), accessToken: refreshedToken };
  }
}

function boundedMessageText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_MESSAGE_BYTES) throw new Error(`Mailbox ${name} is invalid`);
  return value;
}

function parseDate(value: unknown): Date {
  if (typeof value !== 'string') throw new Error('Mailbox receivedAt is invalid');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Mailbox receivedAt is invalid');
  return parsed;
}

function header(headers: unknown, name: string): string {
  if (!Array.isArray(headers)) return '';
  const found = headers.find(item => item && typeof item === 'object' && (item as Record<string, unknown>).name === name);
  return found && typeof (found as Record<string, unknown>).value === 'string' ? (found as Record<string, unknown>).value as string : '';
}

function decodeGmailBody(value: unknown): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const data = (value as Record<string, unknown>).data;
    if (typeof data === 'string' && data.length <= MAX_MESSAGE_BYTES * 2) return Buffer.from(data, 'base64url').toString('utf8');
  }
  return '';
}

function findGmailText(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const object = payload as Record<string, unknown>;
  const direct = decodeGmailBody(object.body);
  if (direct) return direct;
  if (Array.isArray(object.parts)) {
    for (const part of object.parts) {
      if (part && typeof part === 'object' && (part as Record<string, unknown>).mimeType === 'text/plain') {
        const text = decodeGmailBody((part as Record<string, unknown>).body);
        if (text) return text;
      }
    }
    for (const part of object.parts) {
      const text = findGmailText(part);
      if (text) return text;
    }
  }
  return '';
}

function gmailMessage(message: Record<string, unknown>): MailboxMessage {
  const id = boundedMessageText(message.id, 'message identity');
  const payload = message.payload;
  const headers = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).headers : undefined;
  const sender = boundedMessageText(header(payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).headers : undefined, 'From'), 'sender');
  const subject = boundedMessageText(header(payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).headers : undefined, 'Subject'), 'subject');
  const body = boundedMessageText(findGmailText(payload) || message.snippet, 'body');
  const dateHeader = header(headers, 'Date');
  const internalDate = typeof message.internalDate === 'string' ? Number(message.internalDate) : Number.NaN;
  const receivedAt = dateHeader ? parseDate(dateHeader) : new Date(internalDate);
  if (!Number.isFinite(receivedAt.getTime())) throw new Error('Mailbox receivedAt is invalid');
  return { messageId: id, sender, subject, body, receivedAt };
}

function graphMessage(message: Record<string, unknown>): MailboxMessage {
  const senderObject = message.from && typeof message.from === 'object' && !Array.isArray(message.from) ? message.from as Record<string, unknown> : {};
  const address = senderObject.emailAddress && typeof senderObject.emailAddress === 'object' && !Array.isArray(senderObject.emailAddress) ? senderObject.emailAddress as Record<string, unknown> : {};
  const bodyObject = message.body && typeof message.body === 'object' && !Array.isArray(message.body) ? message.body as Record<string, unknown> : {};
  return {
    messageId: boundedMessageText(message.id, 'message identity'),
    sender: boundedMessageText(address.address, 'sender'),
    subject: boundedMessageText(message.subject, 'subject'),
    body: boundedMessageText(bodyObject.content, 'body'),
    receivedAt: parseDate(message.receivedDateTime),
  };
}

function graphCursor(cursor: string | null): string {
  if (!cursor) return GRAPH_API;
  const bounded = boundedCursor(cursor);
  let url: URL;
  try { url = new URL(bounded); } catch { throw new Error('Mailbox cursor is invalid'); }
  if (url.protocol !== 'https:' || url.hostname !== 'graph.microsoft.com' || (url.port && url.port !== '443') || url.pathname !== '/v1.0/me/messages' || url.username || url.password || url.hash) throw new Error('Mailbox cursor is invalid');
  return url.toString();
}

export function createGmailMailboxConnector(input: { userId: string; client?: MailboxHttpClient; refresh?: RefreshMailboxAccessToken }): MailboxConnector {
  const userId = boundedIdentity(input.userId, 'User');
  const client = input.client ?? fetchMailboxClient;
  const refresh = input.refresh ?? (async ({ userId: ownerId, connectionId }) => {
    await refreshEmailOAuthCredential({ userId: ownerId, connectionId });
    return accessTokenFor(ownerId, connectionId, 'GMAIL');
  });
  return {
    provider: 'GMAIL',
    listMessages: async ({ connectionId, cursor, limit }) => {
      let token = await accessTokenFor(userId, boundedIdentity(connectionId, 'Connection'), 'GMAIL');
      const params = new URLSearchParams({ maxResults: String(Math.min(100, Math.max(1, limit))) });
      if (cursor) params.set('pageToken', boundedCursor(cursor));
      const normalizedConnectionId = boundedIdentity(connectionId, 'Connection');
      let requested = await getWithOneRefresh(client, `${GMAIL_API}/messages?${params.toString()}`, userId, normalizedConnectionId, token, refresh);
      token = requested.accessToken;
      const page = requested.body;
      const references = Array.isArray(page.messages) ? page.messages : [];
      const messages: MailboxMessage[] = [];
      for (const reference of references) {
        if (!reference || typeof reference !== 'object' || Array.isArray(reference)) throw new Error('Mailbox message reference is invalid');
        const rawId = (reference as Record<string, unknown>).id;
        if (typeof rawId !== 'string') throw new Error('Message identity is invalid');
        const id = boundedIdentity(rawId, 'Message');
        requested = await getWithOneRefresh(client, `${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`, userId, normalizedConnectionId, token, refresh);
        token = requested.accessToken;
        messages.push(gmailMessage(requested.body));
      }
      const next = page.nextPageToken;
      return { messages, nextCursor: next === undefined ? null : boundedCursor(next) } satisfies MailboxPage;
    },
  };
}

export function createMicrosoftGraphMailboxConnector(input: { userId: string; client?: MailboxHttpClient; refresh?: RefreshMailboxAccessToken }): MailboxConnector {
  const userId = boundedIdentity(input.userId, 'User');
  const client = input.client ?? fetchMailboxClient;
  const refresh = input.refresh ?? (async ({ userId: ownerId, connectionId }) => {
    await refreshEmailOAuthCredential({ userId: ownerId, connectionId });
    return accessTokenFor(ownerId, connectionId, 'MICROSOFT_GRAPH');
  });
  return {
    provider: 'MICROSOFT_GRAPH',
    listMessages: async ({ connectionId, cursor, limit }) => {
      const token = await accessTokenFor(userId, boundedIdentity(connectionId, 'Connection'), 'MICROSOFT_GRAPH');
      const url = new URL(graphCursor(cursor));
      if (!cursor) {
        url.searchParams.set('$top', String(Math.min(100, Math.max(1, limit))));
        url.searchParams.set('$select', 'id,from,subject,body,receivedDateTime');
      }
      const normalizedConnectionId = boundedIdentity(connectionId, 'Connection');
      const requested = await getWithOneRefresh(client, url.toString(), userId, normalizedConnectionId, token, refresh);
      const page = requested.body;
      if (!Array.isArray(page.value)) throw new Error('Mailbox provider response is invalid');
      const messages = page.value.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Mailbox message is invalid');
        return graphMessage(value as Record<string, unknown>);
      });
      const next = page['@odata.nextLink'];
      return { messages, nextCursor: next === undefined ? null : boundedCursor(next) } satisfies MailboxPage;
    },
  };
}

export function createMailboxConnector(input: { userId: string; provider: 'GMAIL' | 'MICROSOFT_GRAPH'; client?: MailboxHttpClient; refresh?: RefreshMailboxAccessToken }): MailboxConnector {
  return input.provider === 'GMAIL' ? createGmailMailboxConnector(input) : createMicrosoftGraphMailboxConnector(input);
}
