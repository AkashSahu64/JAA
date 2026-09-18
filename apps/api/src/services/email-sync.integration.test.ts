import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { syncEmailConnection } from './email-sync';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable mailbox sync persistence', () => {
  const userId = randomUUID();
  const connectionId = randomUUID();
  const messageId = `sync-message-${randomUUID()}`;
  const receivedAt = new Date('2026-09-15T10:00:00.000Z');

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Mailbox Fixture' } });
    await prisma.emailConnection.create({
      data: { id: connectionId, userId, provider: 'GMAIL', accountLabel: 'fixture@example.invalid', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], status: 'ACTIVE' },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('persists the provider cursor, replays duplicate delivery, and audits each completed page', async () => {
    const calls: Array<{ connectionId: string; cursor: string | null; limit: number }> = [];
    const connector = {
      provider: 'GMAIL',
      listMessages: async (input: { connectionId: string; cursor: string | null; limit: number }) => {
        calls.push(input);
        return input.cursor === null
          ? { messages: [{ messageId, sender: 'recruiting@example.invalid', subject: 'Application received', body: 'We received your application.', receivedAt }], nextCursor: 'cursor-1' }
          : { messages: [{ messageId, sender: 'recruiting@example.invalid', subject: 'Application received', body: 'We received your application.', receivedAt }], nextCursor: null };
      },
    };

    await expect(syncEmailConnection({ userId, connectionId, connector, now: new Date('2026-09-15T11:00:00.000Z'), correlationId: 'mail-sync-1' }))
      .resolves.toMatchObject({ connectionId, provider: 'GMAIL', ingested: 1, nextCursor: 'cursor-1' });
    await expect(syncEmailConnection({ userId, connectionId, connector, now: new Date('2026-09-15T12:00:00.000Z'), correlationId: 'mail-sync-2' }))
      .resolves.toMatchObject({ connectionId, provider: 'GMAIL', ingested: 1, nextCursor: null });

    expect(calls).toEqual([
      { connectionId, cursor: null, limit: 100 },
      { connectionId, cursor: 'cursor-1', limit: 100 },
    ]);
    await expect(prisma.emailConnection.findUniqueOrThrow({ where: { id: connectionId } }))
      .resolves.toMatchObject({ syncCursor: null, lastSyncAt: new Date('2026-09-15T12:00:00.000Z') });
    await expect(prisma.emailOutcome.count({ where: { userId, messageId } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { userId, resource: 'EmailConnection', resourceId: connectionId, action: 'EMAIL_SYNC_COMPLETED' } })).resolves.toBe(2);
  });
});
