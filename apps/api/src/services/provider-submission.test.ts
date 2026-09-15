import { describe, expect, it, vi } from 'vitest';

const fillCurrentStep = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => ({
  submissionAuthorization: { findFirst: vi.fn() },
}));

vi.mock('@jobagent/database', () => ({
  withTenant: async (_userId: string, operation: (tx: typeof transaction) => unknown) => operation(transaction),
}));

vi.mock('@jobagent/job-engine', () => ({
  greenhouseApplicationHost: (url: string) => ['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(new URL(url).hostname) ? new URL(url).hostname : null,
  leverApplicationHost: (url: string) => new URL(url).hostname === 'jobs.lever.co' ? 'jobs.lever.co' : null,
  GreenhouseApplicationAdapter: class {
    fillCurrentStep = fillCurrentStep;
  },
  LeverApplicationAdapter: class {
    fillCurrentStep = fillCurrentStep;
  },
}));

import { ProviderSubmissionError, ProviderSubmissionService } from './provider-submission';

const authorization = {
  id: 'authorization-1',
  applicationVersion: 2,
  resumeVersionId: 'resume-version-1',
  preflightEvidence: { resumeVersionId: 'resume-version-1', resumeDocument: { id: 'object-1', kind: 'RESUME_APPROVED', bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'a'.repeat(64), versionId: null, fileName: 'resume.pdf', mimeType: 'application/pdf', byteSize: '20', checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN' } },
  application: {
    id: 'application-1',
    version: 3,
    resumeVersionId: 'resume-version-1',
    job: { source: 'GREENHOUSE', applicationUrl: 'https://boards.greenhouse.io/example/jobs/1' },
    resumeVersion: {
      resumeId: 'resume-1',
      objectMetadata: {
        id: 'object-1', userId: 'user-1', resumeId: 'resume-1', resumeVersionId: 'resume-version-1', kind: 'RESUME_APPROVED', bucket: 'private', objectKey: 'private/resume_approved/user-1/' + 'a'.repeat(64), versionId: null,
        fileName: 'resume.pdf', mimeType: 'application/pdf', encryptionKeyRef: 'S3_MANAGED', checksumSha256: 'a'.repeat(64),
        byteSize: BigInt(20), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
      },
      resume: {
        objectMetadata: {
          userId: 'user-1', resumeId: 'resume-1', kind: 'RESUME_SOURCE', bucket: 'private', objectKey: 'private/resume_source/user-1/' + 'a'.repeat(64), versionId: null,
          fileName: 'resume.pdf', mimeType: 'application/pdf', checksumSha256: 'a'.repeat(64),
          byteSize: BigInt(20), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
        },
      },
    },
  },
  user: { profile: { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: null, locationCity: null, locationState: null, locationCountry: null, linkedIn: null, portfolio: null } },
};

function pageFixture(options: { invalidCount?: number; submitCount?: number; click?: () => Promise<void>; confirmationText?: string } = {}) {
  const upload = { setInputFiles: vi.fn(async () => undefined) };
  const invalid = { count: vi.fn(async () => options.invalidCount ?? 0) };
  const submit = {
    count: vi.fn(async () => options.submitCount ?? 1),
    first: vi.fn(() => ({ click: vi.fn(options.click ?? (async () => undefined)) })),
  };
  const body = { innerText: vi.fn(async () => options.confirmationText ?? '') };
  const page = {
    locator: vi.fn((selector: string) => selector === 'form :invalid'
      ? invalid
      : selector.includes('button[type="submit"]') ? submit
        : selector === 'body' ? body : upload),
  };
  return { page, upload, invalid, submit };
}

function service(page: ReturnType<typeof pageFixture>['page'], requestVerification = vi.fn(async () => undefined)) {
  const browserSessions = {
    start: vi.fn(async () => ({ session: { externalRef: 'browser-session-1' } })),
    withPage: vi.fn(async (_userId: string, _externalRef: string, operation: (currentPage: typeof page) => Promise<unknown>) => operation(page)),
    close: vi.fn(async () => undefined),
  };
  const documentStorage = {
    readAuthorized: vi.fn(async () => ({ buffer: Buffer.from('%PDF-1.7\nfixture'), fileName: 'resume.pdf', mimeType: 'application/pdf' as const })),
  };
  const uploadDocument = vi.fn(async (_fieldId: string, document: { fileName: string; mimeType: string; bytes: Uint8Array }) => {
    const uploadLocator = page.locator('upload') as { setInputFiles: (value: unknown) => Promise<void> };
    await uploadLocator.setInputFiles({ name: document.fileName, mimeType: document.mimeType, buffer: Buffer.from(document.bytes) });
  });
  const ports = { GREENHOUSE: vi.fn(() => ({ uploadDocument })), LEVER: vi.fn(() => ({ uploadDocument })) };
  return { service: new ProviderSubmissionService(browserSessions as never, documentStorage, ports as never, requestVerification), browserSessions, documentStorage, ports, requestVerification };
}

function input() {
  return { userId: 'user-1', applicationId: 'application-1', authorizationId: 'authorization-1', correlationId: 'correlation-1', workerId: 'worker-1' };
}

describe('ProviderSubmissionService', () => {
  it('rejects malformed worker identifiers before tenant or browser work', async () => {
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute({ ...input(), workerId: '   ' })).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<ProviderSubmissionError>);
    expect(transaction.submissionAuthorization.findFirst).not.toHaveBeenCalled();
    expect(subject.browserSessions.start).not.toHaveBeenCalled();
  });

  it('rejects control-bearing and oversized provider execution identities before tenant work', async () => {
    const fixture = pageFixture();
    const subject = service(fixture.page);
    await expect(subject.service.execute({ ...input(), correlationId: 'corr\n1' })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(subject.service.execute({ ...input(), workerId: 'w'.repeat(201) })).rejects.toMatchObject({ code: 'INVALID' });
    expect(transaction.submissionAuthorization.findFirst).not.toHaveBeenCalled();
  });

  it('uploads the verified resume and clicks one unambiguous submit control once', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['resume'],
      fields: [{ id: 'resume', kind: 'FILE', name: 'upload_7', label: 'Candidate document', accessibleName: 'Resume / CV' }],
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).resolves.toMatchObject({ provider: 'GREENHOUSE' });

    expect(transaction.submissionAuthorization.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ applicationId: 'application-1' }),
    }));
    expect(subject.documentStorage.readAuthorized).toHaveBeenCalledWith('user-1', authorization.application.resumeVersion.objectMetadata);
    expect(fixture.upload.setInputFiles).toHaveBeenCalledWith({
      name: 'resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nfixture'),
    });
    expect(fixture.submit.count).toHaveBeenCalledOnce();
    expect(fixture.submit.first).toHaveBeenCalledOnce();
    expect(subject.browserSessions.close).toHaveBeenCalledWith('user-1', 'browser-session-1', 'correlation-1');
  });

  it('selects the independent Lever port for a Lever application', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      application: {
        ...authorization.application,
        job: { source: 'LEVER', applicationUrl: 'https://jobs.lever.co/example/1/apply' },
      },
    });
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['resume'],
      fields: [{ id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' }],
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).resolves.toMatchObject({ provider: 'LEVER' });
    expect(subject.ports.LEVER).toHaveBeenCalledOnce();
    expect(subject.ports.GREENHOUSE).not.toHaveBeenCalled();
    expect(fixture.submit.first).toHaveBeenCalledOnce();
  });

  it('uploads the exact attached cover-letter artifact when the provider requests a file', async () => {
    const coverLetterDocument = {
      id: 'cover-object-1', userId: 'user-1', resumeVersionId: 'resume-version-1', kind: 'COVER_LETTER', bucket: 'private',
      objectKey: 'private/cover_letter/user-1/' + 'c'.repeat(64), versionId: null,
      fileName: 'cover-letter.pdf', mimeType: 'application/pdf', encryptionKeyRef: 'S3_MANAGED',
      checksumSha256: 'c'.repeat(64), byteSize: BigInt(22), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
    };
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      preflightEvidence: {
        ...authorization.preflightEvidence,
        coverLetterDocument: {
          id: coverLetterDocument.id, resumeVersionId: coverLetterDocument.resumeVersionId, kind: coverLetterDocument.kind, bucket: coverLetterDocument.bucket,
          objectKey: coverLetterDocument.objectKey, versionId: coverLetterDocument.versionId,
          fileName: coverLetterDocument.fileName, mimeType: coverLetterDocument.mimeType,
          byteSize: coverLetterDocument.byteSize.toString(), checksumSha256: coverLetterDocument.checksumSha256,
          encryptionKeyRef: coverLetterDocument.encryptionKeyRef, scanStatus: coverLetterDocument.scanStatus,
        },
      },
      application: { ...authorization.application, documents: [{ type: 'cover_letter', objectMetadata: coverLetterDocument }] },
    });
    fillCurrentStep.mockResolvedValue({ advanced: false, validationErrors: [], requiredBlockingFieldIds: ['resume', 'cover-letter'], fields: [
      { id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' },
      { id: 'cover-letter', kind: 'FILE', name: 'cover_letter', label: 'Cover letter' },
    ] });
    const fixture = pageFixture();
    const subject = service(fixture.page);
    subject.documentStorage.readAuthorized.mockImplementation(async (...args: unknown[]) => {
      const document = args[1] as { fileName: string };
      return {
      buffer: Buffer.from(document.fileName === 'cover-letter.pdf' ? '%PDF-cover-letter' : '%PDF-resume'),
      fileName: document.fileName,
      mimeType: 'application/pdf' as const,
      };
    });

    await expect(subject.service.execute(input())).resolves.toMatchObject({ provider: 'GREENHOUSE' });
    expect(subject.documentStorage.readAuthorized).toHaveBeenCalledWith('user-1', coverLetterDocument);
    expect(fixture.upload.setInputFiles).toHaveBeenCalledTimes(2);
  });

  it('returns normalized confirmation evidence without retaining page text', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({ advanced: false, validationErrors: [], requiredBlockingFieldIds: ['resume'], fields: [
      { id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' },
    ] });
    const fixture = pageFixture({ confirmationText: 'Thanks for applying! Application ID: gh-12345' });
    const result = await service(fixture.page).service.execute(input());
    expect(result.confirmation).toMatchObject({ provider: 'GREENHOUSE', confirmationId: 'gh-12345', source: 'CONFIRMATION_PAGE' });
    expect(result.confirmation?.observedAt).toEqual(result.attemptedAt);
    expect(JSON.stringify(result.confirmation)).not.toContain('Thanks for applying');
  });

  it('passes only owner-approved normalized answers into the shared provider resolver', async () => {
    const approvedIdentity = 'GREENHOUSE:default:TEXT:motivation:why_do_you_want_this_role:one';
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      application: {
        ...authorization.application,
        coverLetter: { userId: 'user-1', content: 'Approved cover letter text' },
        questionsNormalized: [{ externalKey: approvedIdentity, answers: [
          { id: 'answer-1', userId: 'user-1', value: 'Approved response', source: 'USER_INPUT', approved: true, approvedAt: new Date('2026-09-14T00:00:00Z'), approvedBy: 'user-1', provenance: { source: 'USER_INPUT' }, version: 2 },
          { id: 'answer-cover', userId: 'user-1', value: { source: 'coverLetter' }, source: 'COVER_LETTER', approved: true, approvedAt: new Date('2026-09-14T00:00:00Z'), approvedBy: 'user-1', provenance: { source: 'COVER_LETTER' }, version: 1 },
        ] }],
      },
    });
    fillCurrentStep.mockClear().mockResolvedValue({ advanced: false, validationErrors: [], requiredBlockingFieldIds: [], fields: [
      { id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' },
    ] });
    const fixture = pageFixture();
    await expect(service(fixture.page).service.execute(input())).resolves.toMatchObject({ provider: 'GREENHOUSE' });
    expect(fillCurrentStep).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.arrayContaining([
      expect.objectContaining({ answerId: 'answer-1', questionIdentity: approvedIdentity, ownerId: 'user-1', value: 'Approved response', approved: true }),
      expect.objectContaining({ answerId: 'answer-cover', value: 'Approved cover letter text', source: 'COVER_LETTER' }),
    ]), 'user-1');
  });

  it('refuses execution when the authorized document checksum changed', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      preflightEvidence: {
        ...authorization.preflightEvidence,
        resumeDocument: { ...(authorization.preflightEvidence.resumeDocument as Record<string, unknown>), checksumSha256: 'b'.repeat(64) },
      },
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<ProviderSubmissionError>);
    expect(subject.browserSessions.start).not.toHaveBeenCalled();
  });

  it('refuses execution when owner approval metadata changed after authorization', async () => {
    const approvedAt = new Date('2026-09-14T00:00:00.000Z');
    const approvedDocument = { ...authorization.application.resumeVersion.objectMetadata, approvalStatus: 'APPROVED', approvedAt, approvedBy: 'user-1' };
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      preflightEvidence: {
        ...authorization.preflightEvidence,
        resumeDocument: { ...(authorization.preflightEvidence.resumeDocument as Record<string, unknown>), approvalStatus: 'APPROVED', approvedAt: approvedAt.toISOString(), approvedBy: 'user-1' },
      },
      application: { ...authorization.application, resumeVersion: { ...authorization.application.resumeVersion, objectMetadata: { ...approvedDocument, approvedAt: new Date('2026-09-14T00:01:00.000Z') } } },
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<ProviderSubmissionError>);
    expect(subject.browserSessions.start).not.toHaveBeenCalled();
  });

  it('refuses execution when matching authorization metadata has an invalid MIME declaration', async () => {
    const invalidDocument = { ...authorization.application.resumeVersion.objectMetadata, mimeType: 'text/plain' };
    transaction.submissionAuthorization.findFirst.mockResolvedValue({
      ...authorization,
      preflightEvidence: {
        ...authorization.preflightEvidence,
        resumeDocument: { ...(authorization.preflightEvidence.resumeDocument as Record<string, unknown>), mimeType: 'text/plain' },
      },
      application: { ...authorization.application, resumeVersion: { ...authorization.application.resumeVersion, objectMetadata: invalidDocument } },
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<ProviderSubmissionError>);
    expect(subject.browserSessions.start).not.toHaveBeenCalled();
  });

  it('refuses forms with any non-resume blocking field before upload or submit', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['work-authorization'],
      fields: [{ id: 'work-authorization', kind: 'TEXT', name: 'authorization', label: 'Work authorization' }],
    });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<ProviderSubmissionError>);
    expect(fixture.upload.setInputFiles).not.toHaveBeenCalled();
    expect(fixture.submit.first).not.toHaveBeenCalled();
  });

  it('creates a durable human-verification handoff for provider checks without submitting', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({ advanced: false, validationErrors: [], requiredBlockingFieldIds: ['captcha'], fields: [
      { id: 'captcha', kind: 'TEXT', name: 'g-recaptcha-response', label: 'Security check' },
    ], assessments: [{ fieldId: 'captcha', disposition: 'HUMAN_VERIFICATION_REQUIRED', verification: 'CAPTCHA', capability: 'REVIEW_ONLY', reason: 'Human verification required' }] });
    const fixture = pageFixture();
    const requestVerification = vi.fn(async () => undefined);
    const subject = service(fixture.page, requestVerification);

    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'HUMAN_VERIFICATION_REQUIRED' } satisfies Partial<ProviderSubmissionError>);
    expect(requestVerification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', applicationId: 'application-1', type: 'CAPTCHA',
      idempotencyKey: 'submission-human-verification:authorization-1:captcha',
      context: { provider: 'GREENHOUSE', fieldId: 'captcha', authorizationId: 'authorization-1' },
    }));
    expect(fixture.submit.first).not.toHaveBeenCalled();
    expect(subject.browserSessions.close).toHaveBeenCalledOnce();
  });

  it('processes a bounded multi-step form before uploading and submitting the exact resume', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockClear();
    fillCurrentStep
      .mockResolvedValueOnce({
        advanced: true, hasNextStep: true, validationErrors: [], requiredBlockingFieldIds: [],
        fields: [{ id: 'name', kind: 'TEXT', name: 'name', label: 'Name' }],
      })
      .mockResolvedValueOnce({
        advanced: false, hasNextStep: false, validationErrors: [], requiredBlockingFieldIds: ['resume'],
        fields: [{ id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' }],
      });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).resolves.toMatchObject({ provider: 'GREENHOUSE' });
    expect(fillCurrentStep).toHaveBeenCalledTimes(2);
    expect(fixture.upload.setInputFiles).toHaveBeenCalledOnce();
    expect(fixture.submit.first).toHaveBeenCalledOnce();
  });

  it('fails closed when a provider repeats the same step identity', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockClear();
    fillCurrentStep
      .mockResolvedValueOnce({ stepIdentity: 'personal-details', advanced: true, hasNextStep: true, validationErrors: [], requiredBlockingFieldIds: [], fields: [] })
      .mockResolvedValueOnce({ stepIdentity: 'personal-details', advanced: false, hasNextStep: false, validationErrors: [], requiredBlockingFieldIds: ['resume'], fields: [] });
    const fixture = pageFixture();
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' } satisfies Partial<ProviderSubmissionError>);
    expect(fixture.submit.first).not.toHaveBeenCalled();
  });

  it('refuses forms with an ambiguous submit control', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['resume'],
      fields: [{ id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' }],
    });
    const fixture = pageFixture({ submitCount: 2 });
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<ProviderSubmissionError>);
    expect(fixture.submit.first).not.toHaveBeenCalled();
  });

  it('refuses provider-side validation errors before submit', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['resume'],
      fields: [{ id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' }],
    });
    const fixture = pageFixture({ invalidCount: 1 });
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<ProviderSubmissionError>);
    expect(fixture.submit.first).not.toHaveBeenCalled();
  });

  it('fails closed with an unknown outcome when the submit click fails', async () => {
    transaction.submissionAuthorization.findFirst.mockResolvedValue(authorization);
    fillCurrentStep.mockResolvedValue({
      advanced: false,
      validationErrors: [],
      requiredBlockingFieldIds: ['resume'],
      fields: [{ id: 'resume', kind: 'FILE', name: 'resume', label: 'Resume' }],
    });
    const fixture = pageFixture({ click: async () => { throw new Error('click timed out'); } });
    const subject = service(fixture.page);

    await expect(subject.service.execute(input())).rejects.toMatchObject({
      code: 'UNKNOWN_OUTCOME',
    } satisfies Partial<ProviderSubmissionError>);
    expect(subject.browserSessions.close).toHaveBeenCalledWith('user-1', 'browser-session-1', 'correlation-1');
  });

  it('rejects a cover-letter artifact bound to a different resume version', async () => {
    const mismatched = {
      ...authorization,
      application: {
        ...authorization.application,
        documents: [{ type: 'cover_letter', objectMetadata: {
          id: 'cover-object-1', userId: 'user-1', resumeVersionId: 'resume-version-other', kind: 'COVER_LETTER',
          bucket: 'private', objectKey: 'private/cover_letter/user-1/' + 'c'.repeat(64), versionId: null,
          fileName: 'cover-letter.pdf', mimeType: 'application/pdf', encryptionKeyRef: 'S3_MANAGED',
          checksumSha256: 'c'.repeat(64), byteSize: BigInt(22), scanStatus: 'CLEAN', deletedAt: null, expiresAt: null,
        } }],
      },
    };
    transaction.submissionAuthorization.findFirst.mockResolvedValue(mismatched);
    const subject = service(pageFixture().page);
    await expect(subject.service.execute(input())).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(subject.documentStorage.readAuthorized).not.toHaveBeenCalled();
  });
});
