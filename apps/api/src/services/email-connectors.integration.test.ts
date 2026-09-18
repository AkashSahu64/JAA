import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { storeDurableCredential } from './durable-credentials';
import { createGmailMailboxConnector } from './email-connectors';
import { syncEmailConnection } from './email-sync';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function response(json: unknown, status = 200) {
  return { status, json: async () => json };
}

describeDatabase.sequential('provider mailbox connector persistence boundary', () => {
  const userId = randomUUID();
  const connectionId = randomUUID();
  let credentialId: string;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Connector Fixture' } });
    const credential = await storeDurableCredential({ userId, name: `mailbox:${connectionId}`, value: JSON.stringify({ accessToken: 'fixture-access-token', tokenType: 'Bearer' }) });
    credentialId = credential.id;
    await prisma.emailConnection.create({
      data: { id: connectionId, userId, provider: 'GMAIL', accountLabel: 'fixture@example.invalid', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], status: 'ACTIVE', credentialRef: credentialId },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('uses the encrypted owner credential, normalizes Gmail content, and persists one idempotent outcome', async () => {
    const messageId = `gmail-integration-${randomUUID()}`;
    const get = async (url: string, accessToken: string) => {
      expect(accessToken).toBe('fixture-access-token');
      if (url.includes('/messages?')) return response({ messages: [{ id: messageId }], nextPageToken: 'cursor-1' });
      return response({
        id: messageId,
        payload: {
          headers: [
            { name: 'From', value: 'Recruiter <recruiter@example.invalid>' },
            { name: 'Subject', value: 'Application received' },
            { name: 'Date', value: 'Tue, 15 Sep 2026 10:00:00 GMT' },
          ],
          body: { data: Buffer.from('We received your application.').toString('base64url') },
        },
      });
    };

    const connector = createGmailMailboxConnector({ userId, client: { get } });
    await expect(syncEmailConnection({ userId, connectionId, connector, now: new Date('2026-09-15T11:00:00.000Z'), correlationId: 'connector-integration-1' }))
      .resolves.toMatchObject({ provider: 'GMAIL', ingested: 1, nextCursor: 'cursor-1' });

    await expect(prisma.emailOutcome.findFirst({ where: { userId, messageId }, select: { source: true, subjectHash: true, bodyHash: true, classification: true } }))
      .resolves.toMatchObject({ source: 'GMAIL', classification: 'APPLICATION_RECEIVED', subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/), bodyHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await expect(prisma.emailConnection.findUniqueOrThrow({ where: { id: connectionId }, select: { syncCursor: true } }))
      .resolves.toEqual({ syncCursor: 'cursor-1' });
    await expect(prisma.auditLog.count({ where: { userId, action: 'CREDENTIAL_ACCESSED', resourceId: credentialId } })).resolves.toBe(1);
  });
});
