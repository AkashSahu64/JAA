import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withTenant: vi.fn(), transition: vi.fn(), findFirst: vi.fn(), applicationFindFirst: vi.fn(), outcomeUpdate: vi.fn(), auditCreate: vi.fn() }));

vi.mock('@jobagent/database', () => ({ prisma: {}, withTenant: mocks.withTenant }));
vi.mock('./application-state-machine', () => ({ transitionApplicationInTenant: mocks.transition }));

import { applyEmailOutcome, linkEmailOutcome, reviewEmailOutcome } from './email-outcomes';

describe('email outcome lifecycle idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withTenant.mockImplementation(async (_userId: string, operation: (tx: unknown) => unknown) => operation({
      emailOutcome: { findFirst: mocks.findFirst, update: mocks.outcomeUpdate },
      application: { findFirst: mocks.applicationFindFirst },
      auditLog: { create: mocks.auditCreate },
    }));
    mocks.findFirst.mockResolvedValue({ id: 'outcome-1', applicationId: 'application-1', classification: 'REJECTION', reviewedAt: new Date('2026-09-14T00:00:00Z'), reviewedBy: 'user-1' });
    mocks.transition.mockResolvedValue({ application: { id: 'application-1', status: 'REJECTED', version: 4 }, transition: { id: 'transition-1' }, replayed: true });
    mocks.outcomeUpdate.mockResolvedValue({ id: 'outcome-1', applicationId: 'application-2' });
    mocks.applicationFindFirst.mockResolvedValue({ id: 'application-2' });
  });

  it('does not duplicate the lifecycle audit on an idempotent replay', async () => {
    await expect(applyEmailOutcome({ userId: 'user-1', outcomeId: 'outcome-1', expectedVersion: 3, idempotencyKey: 'email-apply-1', correlationId: 'corr-1' }))
      .resolves.toMatchObject({ outcomeId: 'outcome-1', target: 'REJECTED', replayed: true });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('does not apply an unreviewed classified outcome to application state', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'outcome-1', applicationId: 'application-1', classification: 'REJECTION', reviewedAt: null, reviewedBy: null });
    await expect(applyEmailOutcome({ userId: 'user-1', outcomeId: 'outcome-1', expectedVersion: 3, idempotencyKey: 'email-apply-1', correlationId: 'corr-1' }))
      .rejects.toThrow('explicitly reviewed');
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('clears prior review when an outcome is relinked to another application', async () => {
    mocks.findFirst.mockResolvedValue({ id: 'outcome-1', applicationId: 'application-1', reviewedAt: new Date('2026-09-14T00:00:00Z'), reviewedBy: 'user-1' });
    await expect(linkEmailOutcome('user-1', 'outcome-1', 'application-2')).resolves.toMatchObject({ applicationId: 'application-2' });
    expect(mocks.outcomeUpdate).toHaveBeenCalledWith({
      where: { id: 'outcome-1' },
      data: { applicationId: 'application-2', reviewedAt: null, reviewedBy: null },
    });
  });

  it('records explicit review without transitioning application state and replays it idempotently', async () => {
    mocks.findFirst.mockResolvedValueOnce({ id: 'outcome-1', applicationId: 'application-1', reviewedAt: null, reviewedBy: null });
    mocks.outcomeUpdate.mockResolvedValueOnce({ id: 'outcome-1', applicationId: 'application-1', reviewedAt: new Date(), reviewedBy: 'user-1' });
    await expect(reviewEmailOutcome('user-1', 'outcome-1')).resolves.toMatchObject({ reviewedBy: 'user-1' });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'EMAIL_OUTCOME_REVIEWED' }) }));
    expect(mocks.transition).not.toHaveBeenCalled();
    mocks.findFirst.mockResolvedValueOnce({ id: 'outcome-1', applicationId: 'application-1', reviewedAt: new Date(), reviewedBy: 'user-1' });
    await expect(reviewEmailOutcome('user-1', 'outcome-1')).resolves.toMatchObject({ reviewedBy: 'user-1' });
    expect(mocks.outcomeUpdate).toHaveBeenCalledTimes(1);
  });
});
