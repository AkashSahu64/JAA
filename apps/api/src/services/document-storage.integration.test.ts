import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, withTenant } from '@jobagent/database';
import { attachDocumentToApplicationInTransaction } from './document-storage';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase('document object metadata', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const resumeId = randomUUID();
  const jobId = randomUUID();
  const versionId = randomUUID();
  const applicationId = randomUUID();
  const objectChecksum = 'c'.repeat(64);

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Object Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Object Fixture' },
    ] });
    await prisma.resume.create({ data: { id: resumeId, userId, content: 'resume fixture' } });
    await prisma.job.create({ data: { id: jobId, source: 'GREENHOUSE', sourceJobId: randomUUID(), company: 'Fixture', title: 'Engineer', description: 'Fixture', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
    await prisma.resumeVersion.create({ data: { id: versionId, resumeId, jobId, content: 'Approved fixture', atsScoreData: { version: 'fixture' }, sourceFacts: [{ sourceFactId: randomUUID(), sourceChecksum: 'd'.repeat(64) }] } });
    await prisma.application.create({ data: { id: applicationId, userId, jobId, resumeVersionId: versionId, status: 'READY_TO_SUBMIT' } });
  });

  afterAll(async () => {
    await prisma.application.deleteMany({ where: { id: applicationId } });
    await prisma.resumeVersion.deleteMany({ where: { id: versionId } });
    await prisma.job.deleteMany({ where: { id: jobId } });
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

  it('attaches only the exact clean document for the application ResumeVersion', async () => {
    const object = await withTenant(userId, tx => tx.objectMetadata.create({ data: {
      userId, resumeVersionId: versionId, bucket: process.env.S3_DOCUMENT_BUCKET ?? 'private-documents',
      objectKey: `private/resume_approved/${userId}/${objectChecksum}`, kind: 'RESUME_APPROVED', fileName: 'resume.pdf',
      mimeType: 'application/pdf', byteSize: BigInt(42), checksumSha256: objectChecksum, encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId, scanDetails: { engine: 'fixture' },
    } }));
    const attached = await withTenant(userId, tx => attachDocumentToApplicationInTransaction(tx, { userId, applicationId, resumeVersionId: versionId, objectMetadataId: object.id, type: 'resume' }));
    expect(attached.replayed).toBe(false);
    expect(attached.document.objectMetadataId).toBe(object.id);
    await expect(withTenant(userId, tx => attachDocumentToApplicationInTransaction(tx, { userId, applicationId, resumeVersionId: randomUUID(), objectMetadataId: object.id, type: 'resume' }))).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
    await expect(withTenant(otherUserId, tx => attachDocumentToApplicationInTransaction(tx, { userId: otherUserId, applicationId, resumeVersionId: versionId, objectMetadataId: object.id, type: 'resume' }))).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });
  });
});
