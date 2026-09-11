import { ApplicationStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createApplicationInput, userTransitionInput } from './applications';

describe('application route creation boundary', () => {
  it('requires exact artifact identifiers and uses a deterministic correlation ID', () => {
    expect(createApplicationInput('user-id', {
      jobId: 'job-id', resumeVersionId: 'version-id', searchProfileId: 'profile-id',
    }, 'request-key')).toEqual({
      userId: 'user-id', jobId: 'job-id', resumeVersionId: 'version-id', searchProfileId: 'profile-id',
      correlationId: 'application-create:user-id:job-id', idempotencyKey: 'request-key',
    });
  });

  it('rejects absent and malformed creation identifiers', () => {
    expect(createApplicationInput('user-id', { jobId: 'job-id', resumeVersionId: 'version-id' }, 'request-key')).toBeNull();
    expect(createApplicationInput('user-id', { jobId: 'job-id', resumeVersionId: 'version-id', searchProfileId: 'profile-id', automationRunId: 3 }, 'request-key')).toBeNull();
  });
});

describe('application route transition boundary', () => {
  it('ignores caller-supplied verifier identity', () => {
    const input = userTransitionInput('application-id', 'user-id', {
      status: ApplicationStatus.CONFIRMED,
      expectedVersion: 7,
      reason: 'Caller supplied evidence',
      idempotencyKey: 'request-key',
      correlationId: 'correlation-id',
      actorType: 'VERIFIER',
      actorId: 'forged-verifier',
    });

    expect(input).toMatchObject({
      actorType: 'USER',
      actorId: 'user-id',
      toStatus: ApplicationStatus.CONFIRMED,
    });
  });
});
