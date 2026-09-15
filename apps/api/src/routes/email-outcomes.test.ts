import { describe, expect, it } from 'vitest';
import { createEmailOutcomeInput } from './email-outcomes';
import { lifecycleTargetForEmailOutcome } from '../services/email-outcomes';

describe('email outcome API boundary', () => {
  const valid = { messageId: '<m-1@example.test>', sender: 'jobs@example.test', subject: 'Application received', body: 'Thank you', receivedAt: '2026-09-14T00:00:00.000Z' };
  it('normalizes a bounded message without exposing raw content in the output shape', () => {
    expect(createEmailOutcomeInput('tenant-a', valid)).toMatchObject({ userId: 'tenant-a', messageId: '<m-1@example.test>', receivedAt: new Date('2026-09-14T00:00:00.000Z') });
  });
  it.each([
    [{ ...valid, messageId: '' }], [{ ...valid, receivedAt: 'invalid' }], [{ ...valid, body: '' }], [{ ...valid, applicationId: '   ' }],
  ])('rejects malformed input', (body) => expect(createEmailOutcomeInput('tenant-a', body)).toBeNull());

  it.each([
    ['REJECTION', 'REJECTED'], ['INTERVIEW_INVITATION', 'INTERVIEW'], ['INTERVIEW_SCHEDULING', 'INTERVIEW'], ['OFFER', 'OFFER'], ['WITHDRAWAL', 'WITHDRAWN'],
  ] as const)('maps only reviewed actionable outcomes: %s', (classification, target) => {
    expect(lifecycleTargetForEmailOutcome(classification)).toBe(target);
  });

  it.each(['APPLICATION_RECEIVED', 'RECRUITER_MESSAGE', 'UNCLASSIFIED'] as const)('does not mutate lifecycle for non-actionable outcome: %s', (classification) => {
    expect(lifecycleTargetForEmailOutcome(classification)).toBeNull();
  });

  it('maps an assessment email to the durable assessment lifecycle state', () => {
    expect(lifecycleTargetForEmailOutcome('ASSESSMENT')).toBe('ASSESSMENT');
  });
});
