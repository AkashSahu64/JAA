import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ withTenant: vi.fn(), transition: vi.fn(), executeRaw: vi.fn() }));
vi.mock('@jobagent/database', () => ({ withTenant: mocks.withTenant }));
vi.mock('./application-state-machine', () => ({ transitionApplicationInTenant: mocks.transition }));

import { decideOffer, recordInterview, recordOffer } from './application-lifecycle';

describe('application lifecycle input boundary', () => {
  it('contains the unique-replay handling in the durable service path', async () => {
    expect(typeof recordInterview).toBe('function');
    expect(typeof recordOffer).toBe('function');
  });
  it.each([
    ['meeting URL', { type: 'TECHNICAL', company: 'Acme', role: 'Engineer', meetingUrl: 'http://insecure.example' }],
    ['credential-bearing meeting URL', { type: 'TECHNICAL', company: 'Acme', role: 'Engineer', meetingUrl: 'https://user:secret@example.test/meet' }],
    ['interview date', { type: 'TECHNICAL', company: 'Acme', role: 'Engineer', date: new Date('invalid') }],
    ['interview round', { type: 'TECHNICAL', company: 'Acme', role: 'Engineer', round: 0 }],
  ])('rejects invalid %s before persistence', async (_name, input) => {
    await expect(recordInterview({ userId: 'user-1', applicationId: 'application-1', ...input })).rejects.toThrow();
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects invalid offer values before persistence', async () => {
    await expect(recordOffer({ userId: 'user-1', applicationId: 'application-1', company: 'Acme', role: 'Engineer', salaryOffered: Number.NaN }))
      .rejects.toThrow('Offer salary is invalid');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects unbounded offer amounts before persistence', async () => {
    await expect(recordOffer({ userId: 'user-1', applicationId: 'application-1', company: 'Acme', role: 'Engineer', salaryOffered: 1_000_000_001 }))
      .rejects.toThrow('Offer salary is invalid');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects an offer that expires before it starts', async () => {
    await expect(recordOffer({
      userId: 'user-1', applicationId: 'application-1', company: 'Acme', role: 'Engineer',
      startDate: new Date('2027-01-10T00:00:00Z'), expiresAt: new Date('2027-01-09T00:00:00Z'),
    })).rejects.toThrow('expiry must be after');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it.each([
    { userId: 42 as never, applicationId: 'application-1' },
    { userId: 'user-1', applicationId: 42 as never },
    { userId: 'user-1', applicationId: 'application-1', sourceEventId: 42 as never },
  ])('rejects malformed lifecycle identities before persistence', async input => {
    await expect(recordOffer({ ...input, company: 'Acme', role: 'Engineer' })).rejects.toThrow('Lifecycle identity');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('requires an idempotency identity for offer decisions', async () => {
    await expect(decideOffer({ userId: 'user-1', applicationId: 'application-1', offerId: 'offer-1', decision: 'ACCEPTED' }))
      .rejects.toThrow('idempotency identity');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('rejects control characters before lifecycle persistence', async () => {
    await expect(recordInterview({ userId: 'user-1', applicationId: 'application-1\n', type: 'TECHNICAL', company: 'Acme', role: 'Engineer' })).rejects.toThrow('Lifecycle identity');
    await expect(recordOffer({ userId: 'user-1', applicationId: 'application-1', company: 'Acme\r\n', role: 'Engineer' })).rejects.toThrow('Company');
    await expect(decideOffer({ userId: 'user-1', applicationId: 'application-1', offerId: 'offer-1', decision: 'ACCEPTED', sourceEventId: 'event-1\n' })).rejects.toThrow('Lifecycle identity');
    expect(mocks.withTenant).not.toHaveBeenCalled();
  });

  it('exposes durable lifecycle recorders for source-event idempotency', () => {
    expect(recordInterview).toEqual(expect.any(Function));
    expect(recordOffer).toEqual(expect.any(Function));
  });

  it('replays an existing interview source event without re-running a later state transition', async () => {
    const existing = { id: 'interview-1', userId: 'user-1', applicationId: 'application-1', type: 'TECHNICAL', company: 'Acme', role: 'Engineer', round: 1, interviewer: undefined, meetingUrl: undefined, date: undefined };
    const executeRaw = vi.fn();
    mocks.withTenant.mockImplementationOnce(async (_userId: string, callback: (tx: unknown) => unknown) => callback({ $executeRaw: executeRaw, interview: { findUnique: vi.fn().mockResolvedValue(existing) } }));
    await expect(recordInterview({ userId: 'user-1', applicationId: 'application-1', sourceEventId: 'event-1', type: 'TECHNICAL', company: 'Acme', role: 'Engineer' })).resolves.toEqual(existing);
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('replays an existing offer source event without re-running a later state transition', async () => {
    const existing = { id: 'offer-1', userId: 'user-1', applicationId: 'application-1', company: 'Acme', role: 'Engineer', salaryOffered: undefined, currency: undefined, benefits: undefined, startDate: undefined, expiresAt: undefined };
    const executeRaw = vi.fn();
    mocks.withTenant.mockImplementationOnce(async (_userId: string, callback: (tx: unknown) => unknown) => callback({ $executeRaw: executeRaw, offer: { findUnique: vi.fn().mockResolvedValue(existing) } }));
    await expect(recordOffer({ userId: 'user-1', applicationId: 'application-1', sourceEventId: 'event-2', company: 'Acme', role: 'Engineer' })).resolves.toEqual(existing);
    expect(mocks.transition).not.toHaveBeenCalled();
  });
});
