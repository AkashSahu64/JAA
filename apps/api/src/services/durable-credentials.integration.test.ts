import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { retrieveDurableCredential, revokeDurableCredential, storeDurableCredential } from './durable-credentials';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('durable credential tenant boundary', () => {
  const ownerId = randomUUID();
  const otherId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@example.invalid`, passwordHash: 'fixture', name: 'Credential Owner' },
      { id: otherId, email: `${otherId}@example.invalid`, passwordHash: 'fixture', name: 'Other Tenant' },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, otherId] } } });
    await prisma.$disconnect();
  });

  it('encrypts, isolates, audits, and revokes credential material', async () => {
    const secret = `fixture-secret-${randomUUID()}`;
    const record = await storeDurableCredential({ userId: ownerId, name: 'mailbox', value: secret });
    expect(await retrieveDurableCredential(otherId, record.id)).toBeNull();
    expect(await retrieveDurableCredential(ownerId, record.id)).toBe(secret);
    const stored = await prisma.credentialRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(stored.encryptedValue).not.toContain(secret);
    expect(await prisma.auditLog.count({ where: { userId: ownerId, resourceId: record.id, action: { in: ['CREDENTIAL_STORED', 'CREDENTIAL_ACCESSED'] } } })).toBe(2);
    await revokeDurableCredential(ownerId, record.id);
    expect(await retrieveDurableCredential(ownerId, record.id)).toBeNull();
    const revoked = await prisma.credentialRecord.findUniqueOrThrow({ where: { id: record.id } });
    expect(revoked.encryptedValue).toBe('');
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });
});
