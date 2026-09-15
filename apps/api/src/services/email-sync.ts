import { withTenant } from '@jobagent/database';
import { EmailMessageInput, ingestEmailOutcome } from './email-outcomes';
import { EMAIL_PROVIDERS } from './email-connections';

export interface MailboxMessage extends Omit<EmailMessageInput, 'userId'> {
  /** Provider cursor is opaque and is never interpreted as an instruction. */
  providerCursor?: string;
}

export interface MailboxPage {
  messages: MailboxMessage[];
  nextCursor: string | null;
}

export interface MailboxConnector {
  provider: string;
  listMessages(input: { connectionId: string; cursor: string | null; limit: number }): Promise<MailboxPage>;
}

const MAX_MESSAGES_PER_SYNC = 100;
const MAX_CURSOR_LENGTH = 512;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function boundedCursor(cursor: string | null | undefined): string | null {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || Array.from(cursor).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid mailbox cursor');
  }
  return cursor;
}

export function validateMailboxSyncPage(page: MailboxPage): void {
  if (!page || !Array.isArray(page.messages) || page.messages.length > MAX_MESSAGES_PER_SYNC) throw new Error('Mailbox page exceeds safety limit');
  boundedCursor(page.nextCursor);
  for (const message of page.messages) {
    if (!message || typeof message !== 'object' || typeof message.messageId !== 'string' || !message.messageId.trim()) throw new Error('Mailbox message identity is required');
    if (typeof message.sender !== 'string' || typeof message.subject !== 'string' || typeof message.body !== 'string'
      || !message.sender.trim() || !message.subject.trim() || !message.body.trim()) throw new Error('Mailbox message content is invalid');
    if (message.messageId.length > 512 || message.sender.length > 512 || message.subject.length > 20_000 || message.body.length > 2_000_000) throw new Error('Mailbox message exceeds safety limit');
    if (hasControlCharacters(message.messageId) || hasControlCharacters(message.sender) || hasControlCharacters(message.subject)) throw new Error('Mailbox message identity or header is invalid');
    if (!(message.receivedAt instanceof Date) || !Number.isFinite(message.receivedAt.getTime())) throw new Error('Mailbox message timestamp is invalid');
    if (message.applicationId !== undefined && (typeof message.applicationId !== 'string' || !message.applicationId.trim() || message.applicationId.length > 200 || hasControlCharacters(message.applicationId))) throw new Error('Mailbox application identity is invalid');
  }
}

export function validateMailboxSyncTime(value: unknown): asserts value is Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new Error('Mailbox sync timestamp is invalid or too far in the future');
  }
}

/**
 * Runs one bounded provider page. Provider implementations are injected so
 * webpage/email content cannot select credentials or alter classification policy.
 * The database stores hashes/parser evidence only; duplicate message delivery is safe.
 */
export async function syncEmailConnection(input: { userId: string; connectionId: string; connector: MailboxConnector; now?: Date; correlationId?: string }) {
  if (!input || typeof input.userId !== 'string' || typeof input.connectionId !== 'string'
    || !input.userId.trim() || !input.connectionId.trim() || input.userId.length > 200 || input.connectionId.length > 200
    || hasControlCharacters(input.userId) || hasControlCharacters(input.connectionId)) throw new Error('Mailbox sync identity is required');
  if (input.correlationId !== undefined && (typeof input.correlationId !== 'string' || !input.correlationId.trim() || input.correlationId.length > 200 || hasControlCharacters(input.correlationId))) throw new Error('Mailbox sync correlation is invalid');
  if (!input.connector || typeof input.connector.listMessages !== 'function') throw new Error('Mailbox connector is required');
  if (!EMAIL_PROVIDERS.includes(input.connector.provider as typeof EMAIL_PROVIDERS[number])) throw new Error('Unsupported mailbox provider');
  const syncAt = input.now ?? new Date();
  validateMailboxSyncTime(syncAt);

  const connection = await withTenant(input.userId, async (tx) => {
    const db = tx as any;
    return db.emailConnection.findFirst({ where: { id: input.connectionId, userId: input.userId, status: 'ACTIVE' }, select: { id: true, provider: true, syncCursor: true } });
  });
  if (!connection) throw new Error('Active email connection not found');
  if (!EMAIL_PROVIDERS.includes(connection.provider as typeof EMAIL_PROVIDERS[number])) throw new Error('Unsupported consented mailbox provider');
  if (connection.provider !== input.connector.provider) throw new Error('Mailbox connector does not match consented provider');

  const page = await input.connector.listMessages({ connectionId: connection.id, cursor: boundedCursor(connection.syncCursor), limit: MAX_MESSAGES_PER_SYNC });
  validateMailboxSyncPage(page);
  let ingested = 0;
  for (const message of page.messages) {
    await ingestEmailOutcome({ ...message, source: input.connector.provider, userId: input.userId });
    ingested += 1;
  }
  const nextCursor = boundedCursor(page.nextCursor);
  await withTenant(input.userId, async (tx) => {
    const db = tx as any;
    const advanced = await db.emailConnection.updateMany({
      // Optimistic ownership: a concurrent sync that already advanced the
      // cursor must not be overwritten by this slower page.
      where: { id: connection.id, userId: input.userId, status: 'ACTIVE', syncCursor: connection.syncCursor },
      data: { syncCursor: nextCursor, lastSyncAt: syncAt },
    });
    if (advanced.count !== 1) throw new Error('Mailbox sync cursor changed; retry from the current durable cursor');
    await db.auditLog.create({ data: { userId: input.userId, action: 'EMAIL_SYNC_COMPLETED', resource: 'EmailConnection', resourceId: connection.id, details: { provider: connection.provider, ingested, nextCursorPresent: nextCursor !== null, correlationId: input.correlationId?.trim() ?? null } } });
  });
  return { connectionId: connection.id, provider: connection.provider, ingested, nextCursor };
}
