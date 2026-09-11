import { randomUUID } from 'node:crypto';
import { ApplicationStatus } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { ApplicationTransitionError, transitionApplication } from './application-state-machine';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('application transition transaction', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const applicationId = randomUUID();
  const otherResumeId = randomUUID();
  const otherResumeVersionId = randomUUID();
  const otherApplicationId = randomUUID();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'State Machine Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other State Machine Fixture' },
    ] });
    await prisma.job.create({ data: { id: jobId, source: 'fixture', company: 'Example', title: 'Engineer', description: 'fixture', applicationUrl: 'https://example.invalid/apply', sourceUrl: 'https://example.invalid/job' } });
    await prisma.resume.createMany({ data: [
      { id: resumeId, userId, name: 'Fixture resume', content: 'Approved fixture facts only.' },
      { id: otherResumeId, userId: otherUserId, name: 'Other fixture resume', content: 'Approved fixture facts only.' },
    ] });
    await prisma.resumeVersion.createMany({ data: [
      { id: resumeVersionId, resumeId, content: 'Approved fixture facts only.' },
      { id: otherResumeVersionId, resumeId: otherResumeId, content: 'Approved fixture facts only.' },
    ] });
    await prisma.application.createMany({ data: [
      { id: applicationId, userId, jobId, resumeVersionId },
      { id: otherApplicationId, userId: otherUserId, jobId, resumeVersionId: otherResumeVersionId },
    ] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.$disconnect();
  });

  it('atomically updates state, history, audit, and outbox', async () => {
    const idempotencyKey = randomUUID();
    const correlationId = randomUUID();
    const result = await transitionApplication({ applicationId, userId, toStatus: ApplicationStatus.QUALIFIED, expectedVersion: 1, actorType: 'SYSTEM', reason: 'Deterministic eligibility checks passed', idempotencyKey, correlationId });

    expect(result.replayed).toBe(false);
    expect(result.application.status).toBe(ApplicationStatus.QUALIFIED);
    expect(result.application.version).toBe(2);
    await expect(prisma.applicationStatusTransition.count({ where: { applicationId, idempotencyKey } })).resolves.toBe(1);
    await expect(prisma.auditLog.count({ where: { userId, resourceId: applicationId, action: 'APPLICATION_STATUS_TRANSITIONED' } })).resolves.toBe(1);
    await expect(prisma.outboxEvent.count({ where: { aggregateId: applicationId, correlationId } })).resolves.toBe(1);
  });

  it('returns the prior result for an identical idempotent replay', async () => {
    const idempotencyKey = randomUUID();
    const input = { applicationId, userId, toStatus: ApplicationStatus.RESUME_GENERATED, expectedVersion: 2, actorType: 'WORKER' as const, reason: 'Approved facts rendered', idempotencyKey, correlationId: randomUUID() };
    await expect(transitionApplication(input)).resolves.toMatchObject({ replayed: false });
    await expect(transitionApplication(input)).resolves.toMatchObject({ replayed: true, application: { version: 3 } });
    await expect(prisma.applicationStatusTransition.count({ where: { idempotencyKey } })).resolves.toBe(1);
  });

  it('serializes concurrent identical transitions into one write and one replay', async () => {
    const idempotencyKey = randomUUID();
    const input = { applicationId: otherApplicationId, userId: otherUserId, toStatus: ApplicationStatus.QUALIFIED, expectedVersion: 1, actorType: 'SYSTEM' as const, reason: 'Concurrent qualification', idempotencyKey, correlationId: randomUUID(), metadata: { source: 'test' } };
    const results = await Promise.all([transitionApplication(input), transitionApplication(input)]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    await expect(prisma.applicationStatusTransition.count({ where: { userId: otherUserId, idempotencyKey } })).resolves.toBe(1);
  });

  it('rejects stale writes, illegal jumps, and false confirmation', async () => {
    await expect(transitionApplication({ applicationId, userId, toStatus: ApplicationStatus.RESUME_VALIDATED, expectedVersion: 2, actorType: 'WORKER', reason: 'stale', idempotencyKey: randomUUID(), correlationId: randomUUID() })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(transitionApplication({ applicationId, userId, toStatus: ApplicationStatus.CONFIRMED, expectedVersion: 3, actorType: 'SYSTEM', reason: 'unverified', idempotencyKey: randomUUID(), correlationId: randomUUID() })).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    await expect(transitionApplication({ applicationId, userId, toStatus: ApplicationStatus.OFFER, expectedVersion: 3, actorType: 'SYSTEM', reason: 'illegal jump', idempotencyKey: randomUUID(), correlationId: randomUUID() })).rejects.toBeInstanceOf(ApplicationTransitionError);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: ApplicationStatus.RESUME_GENERATED, version: 3 });
  });

  it('rejects materially different reuses and scopes keys by tenant', async () => {
    const sharedKey = randomUUID();
    const correlationId = randomUUID();
    const input = { applicationId, userId, toStatus: ApplicationStatus.RESUME_VALIDATED, expectedVersion: 3, actorType: 'WORKER' as const, actorId: 'worker-a', reason: 'Validated', idempotencyKey: sharedKey, correlationId, metadata: { check: 1 } };
    await transitionApplication(input);
    for (const changed of [
      { actorId: 'worker-b' },
      { reason: 'Different reason' },
      { correlationId: randomUUID() },
      { expectedVersion: 4 },
      { actorType: 'SYSTEM' as const },
      { metadata: { check: 2 } },
    ]) {
      await expect(transitionApplication({ ...input, ...changed })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    }
    await expect(transitionApplication({ applicationId: otherApplicationId, userId: otherUserId, toStatus: ApplicationStatus.RESUME_GENERATED, expectedVersion: 2, actorType: 'WORKER', reason: 'Tenant-local key', idempotencyKey: sharedKey, correlationId: randomUUID() }))
      .resolves.toMatchObject({ replayed: false });
  });

  it('allows only one concurrent writer for an expected version', async () => {
    const build = (key: string) => transitionApplication({ applicationId, userId, toStatus: ApplicationStatus.ATS_VALIDATED, expectedVersion: 4, actorType: 'WORKER' as const, reason: 'Concurrent validation', idempotencyKey: key, correlationId: randomUUID() });
    const results = await Promise.allSettled([build(randomUUID()), build(randomUUID())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(prisma.application.findUniqueOrThrow({ where: { id: applicationId } })).resolves.toMatchObject({ status: ApplicationStatus.ATS_VALIDATED, version: 5 });
  });
});
