import { describe, expect, it } from 'vitest';
import { ApplicationStatus } from '@prisma/client';
import { allowedTransitions, ApplicationTransitionError, canTransition } from './application-state-machine';

describe('application state graph', () => {
  it('allows the controlled forward workflow', () => {
    expect(canTransition(ApplicationStatus.DISCOVERED, ApplicationStatus.QUALIFIED)).toBe(true);
    expect(canTransition(ApplicationStatus.READY_TO_SUBMIT, ApplicationStatus.SUBMISSION_PENDING)).toBe(true);
    expect(canTransition(ApplicationStatus.SUBMISSION_PENDING, ApplicationStatus.READY_TO_SUBMIT)).toBe(true);
    expect(canTransition(ApplicationStatus.SUBMISSION_PENDING, ApplicationStatus.WAITING_FOR_USER)).toBe(true);
    expect(canTransition(ApplicationStatus.SUBMISSION_PENDING, ApplicationStatus.UNCONFIRMED)).toBe(true);
    expect(canTransition(ApplicationStatus.UNCONFIRMED, ApplicationStatus.CONFIRMED)).toBe(true);
  });

  it('denies jumps and terminal-state transitions', () => {
    expect(canTransition(ApplicationStatus.DISCOVERED, ApplicationStatus.CONFIRMED)).toBe(false);
    expect(allowedTransitions(ApplicationStatus.REJECTED)).toEqual([]);
    expect(allowedTransitions(ApplicationStatus.ACCEPTED)).toEqual([]);
    expect(allowedTransitions(ApplicationStatus.WITHDRAWN)).toEqual([]);
  });

  it('models user pauses and safe retries explicitly', () => {
    expect(canTransition(ApplicationStatus.FORM_FILLED, ApplicationStatus.WAITING_FOR_USER)).toBe(true);
    expect(canTransition(ApplicationStatus.WAITING_FOR_USER, ApplicationStatus.READY_TO_SUBMIT)).toBe(true);
    expect(canTransition(ApplicationStatus.FAILED, ApplicationStatus.RETRY_PENDING)).toBe(true);
    expect(canTransition(ApplicationStatus.RETRY_PENDING, ApplicationStatus.QUEUED)).toBe(true);
  });

  it('exposes stable transition error codes', () => {
    const error = new ApplicationTransitionError('STALE_VERSION', 'stale');
    expect(error.name).toBe('ApplicationTransitionError');
    expect(error.code).toBe('STALE_VERSION');
  });
});
