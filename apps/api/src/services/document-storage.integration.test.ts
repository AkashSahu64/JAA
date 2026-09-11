import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@jobagent/database';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('document object metadata', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const resumeId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Object Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Object Fixture' },
    ] });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'resume fixture' } });
  });

  afterAll(async () => {
    await prisma.resume.deleteMany({ where: { id: resumeId } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('binds a private, scanned object to its owner resume', async () => {
    const object = await withTenant(userId, tx => tx.objectMetadata.create({ data: {
      userId,
      resumeId,
      bucket: 'private-documents',
      objectKey: `private/resumes/${userId}/fixture`,
      kind: 'RESUME_SOURCE',
      fileName: 'resume.pdf',
      mimeType: 'application/pdf',
      byteSize: BigInt(42),
      checksumSha256: 'a'.repeat(64),
      encryptionKeyRef: 'S3_MANAGED',
      scanStatus: 'CLEAN',
      scanDetails: { engine: 'fixture' },
    } }));
    expect(object.resumeId).toBe(resumeId);
    await expect(withTenant(otherUserId, tx => tx.objectMetadata.findFirst({ where: { id: object.id, userId: otherUserId } }))).resolves.toBeNull();
  });
});
