import { describe, expect, it, vi } from 'vitest';
import { nextScheduledRun, SchedulerError } from './scheduler';
import { claimDueEmailSyncs, claimDueSearchSchedules, parseDiscoveryAccounts, runDueSearchSchedules, scheduleApplicationRun, validateApplicationRunAt } from './durable-scheduler';

const schedulerDatabase = vi.hoisted(() => ({ withService: vi.fn(), withTenant: vi.fn(), outboxEvent: { upsert: vi.fn() } }));
vi.mock('@jobagent/database', () => schedulerDatabase);
const automationJobs = vi.hoisted(() => ({ createAutomationJobInTransaction: vi.fn(async (_tx: unknown, input: unknown) => ({ id: 'automation-1', status: 'AVAILABLE', availableAt: new Date('2026-01-01T01:00:00Z'), replayed: false, input })) }));
vi.mock('./automation-jobs', () => automationJobs);

describe('durable scheduler kernel', () => {
  it('bounds and deduplicates persisted discovery accounts', () => {
    expect(parseDiscoveryAccounts([
      { source: 'LEVER', account: 'example' },
      { source: 'LEVER', account: 'example' },
      { source: 'GREENHOUSE', account: 'board' },
    ])).toEqual({ greenhouseBoards: ['board'], leverCompanies: ['example'], ashbyBoards: [] });
    expect(parseDiscoveryAccounts([{ source: 'LEVER', account: 'x'.repeat(201) }])).toBeNull();
    expect(parseDiscoveryAccounts([{ source: 'LEVER', account: 'company\nforged' }])).toBeNull();
    expect(parseDiscoveryAccounts(Array.from({ length: 61 }, (_, index) => ({ source: 'LEVER', account: `company-${index}` })))).toBeNull();
  });

  it('calculates recurring runs without in-memory timer state', () => {
    expect(nextScheduledRun('HOURLY', null, new Date('2026-01-01T10:15:00Z'))).toEqual(new Date('2026-01-01T11:00:00Z'));
    expect(nextScheduledRun('EVERY_3_HOURS', null, new Date('2026-01-01T10:15:00Z'))).toEqual(new Date('2026-01-01T12:00:00Z'));
    expect(nextScheduledRun('DAILY', null, new Date('2026-01-01T10:15:00Z'))).toEqual(new Date('2026-01-02T00:00:00Z'));
    expect(nextScheduledRun('ONCE', null, new Date('2026-01-01T10:15:00Z'))).toBeNull();
  });

  it('supports custom cron and IANA timezone matching', () => {
    expect(nextScheduledRun('CUSTOM', '30 9 * * 1-5', new Date('2026-01-02T15:00:00Z'), 'America/New_York'))
      .toEqual(new Date('2026-01-05T14:30:00Z'));
  });

  it('uses standard cron OR semantics when day-of-month and weekday are both restricted', () => {
    expect(nextScheduledRun('CUSTOM', '0 9 1 * 1', new Date('2026-01-01T10:00:00Z'), 'UTC'))
      .toEqual(new Date('2026-01-05T09:00:00Z'));
  });

  it('accepts the standard weekday 7 alias for Sunday', () => {
    expect(nextScheduledRun('CUSTOM', '0 9 * * 7', new Date('2026-01-02T10:00:00Z'), 'UTC'))
      .toEqual(new Date('2026-01-04T09:00:00Z'));
  });

  it.each(['', '* * * *', '60 * * * *', '0 0 0 * *'])('rejects invalid cron %s', expression => {
    expect(() => nextScheduledRun('CUSTOM', expression, new Date())).toThrow(SchedulerError);
  });

  it('rejects a corrupted persisted schedule name before interpreting custom cron', () => {
    expect(() => nextScheduledRun('CORRUPTED' as never, '0 * * * *', new Date())).toThrow('Schedule name');
  });

  it('fails closed for malformed runtime dates and timezones', () => {
    expect(() => nextScheduledRun('DAILY', null, 'not-a-date' as never)).toThrow('start time');
    expect(() => nextScheduledRun('DAILY', null, new Date(Number.POSITIVE_INFINITY))).toThrow('start time');
    expect(() => nextScheduledRun('DAILY', null, new Date(), ' ')).toThrow('Timezone');
  });

  it('validates persisted timezones even when a one-time schedule has no next run', () => {
    expect(nextScheduledRun('ONCE', null, new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
    expect(() => nextScheduledRun('ONCE', null, new Date('2026-01-01T00:00:00Z'), 'Not/AZone')).toThrow('Timezone');
  });

  it('bounds durable application run slots instead of relying on an in-memory timer', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(validateApplicationRunAt(new Date('2026-01-01T00:05:00Z'), now)).toEqual(new Date('2026-01-01T00:05:00Z'));
    expect(() => validateApplicationRunAt(new Date('2025-12-31T23:59:00Z'), now)).toThrow('past');
    expect(() => validateApplicationRunAt(new Date('2026-04-02T00:00:01Z'), now)).toThrow('future');
  });

  it('selects the provider handler from tenant-owned application state', async () => {
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', status: 'APPLICATION_STARTED', job: { source: 'LEVER' }, automationRun: null })) },
      auditLog: { create: vi.fn() },
      outboxEvent: { upsert: vi.fn() },
    };
    schedulerDatabase.withTenant.mockImplementation(async (_userId, callback) => callback(tx as never));
    await expect(scheduleApplicationRun({
      userId: 'user-1', applicationId: 'application-1', runAt: new Date('2026-01-01T01:00:00Z'),
      correlationId: 'corr-1', idempotencyKey: 'schedule-1',
    }, new Date('2026-01-01T00:00:00Z'))).resolves.toMatchObject({ id: 'automation-1', replayed: false });
    expect(automationJobs.createAutomationJobInTransaction).toHaveBeenCalledWith(tx, expect.objectContaining({
      type: 'COMPLETE_LEVER_APPLICATION', applicationId: 'application-1', availableAt: new Date('2026-01-01T01:00:00Z'),
    }));
    expect(tx.outboxEvent.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { idempotencyKey: 'application-run-scheduled:automation-1' },
      create: expect.objectContaining({ eventType: 'application.run.scheduled', aggregateId: 'application-1' }),
    }));
  });

  it('rejects control characters in durable application schedule keys', async () => {
    schedulerDatabase.withTenant.mockClear();
    await expect(scheduleApplicationRun({
      userId: 'user-1', applicationId: 'application-1', runAt: new Date('2026-01-01T01:00:00Z'),
      correlationId: 'corr\nforged', idempotencyKey: 'schedule-2',
    }, new Date('2026-01-01T00:00:00Z'))).rejects.toThrow('identifiers are invalid');
    expect(schedulerDatabase.withTenant).not.toHaveBeenCalled();
  });

  it('binds scheduled work to a paused owner run so dispatcher pause/resume remains durable', async () => {
    schedulerDatabase.withTenant.mockReset();
    const tx = {
      application: { findFirst: vi.fn(async () => ({ id: 'application-1', status: 'APPLICATION_STARTED', job: { source: 'GREENHOUSE' }, automationRun: { id: 'run-1', status: 'PAUSED' } })) },
      auditLog: { create: vi.fn() },
      outboxEvent: { upsert: vi.fn() },
    };
    schedulerDatabase.withTenant.mockImplementationOnce(async (_userId, callback) => callback(tx as never));
    await expect(scheduleApplicationRun({
      userId: 'user-1', applicationId: 'application-1', automationRunId: 'run-1', runAt: new Date('2026-01-01T01:00:00Z'),
      correlationId: 'corr-2', idempotencyKey: 'schedule-3',
    }, new Date('2026-01-01T00:00:00Z'))).resolves.toMatchObject({ id: 'automation-1' });
    expect(automationJobs.createAutomationJobInTransaction).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ automationRunId: 'run-1', type: 'COMPLETE_GREENHOUSE_APPLICATION' }));
  });

  it.each(['FORM_FILLED', 'WAITING_FOR_USER'])('does not schedule a provider run from the %s checkpoint', async status => {
    schedulerDatabase.withTenant.mockReset();
    const tx = { application: { findFirst: vi.fn(async () => ({ id: 'application-1', status, job: { source: 'LEVER' }, automationRun: null })) } };
    schedulerDatabase.withTenant.mockImplementationOnce(async (_userId, callback) => callback(tx as never));
    await expect(scheduleApplicationRun({
      userId: 'user-1', applicationId: 'application-1', runAt: new Date('2026-01-01T01:00:00Z'),
      correlationId: 'corr-3', idempotencyKey: `schedule-invalid-${status}`,
    }, new Date('2026-01-01T00:00:00Z'))).rejects.toThrow('not eligible');
    expect(automationJobs.createAutomationJobInTransaction).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: 'application-1', idempotencyKey: `schedule-invalid-${status}` }));
  });

  it('rejects invalid durable scheduler time before database access', async () => {
    await expect(claimDueSearchSchedules('user-1', new Date(Number.NaN))).rejects.toThrow('Scheduler time');
  });

  it('rejects invalid global scheduler inputs before loading users', async () => {
    await expect(runDueSearchSchedules(new Date(Number.NaN))).rejects.toThrow('Scheduler time');
    await expect(runDueSearchSchedules(new Date(), 0)).rejects.toThrow('per-user limit');
  });

  it('enumerates active tenants through the service maintenance boundary', async () => {
    schedulerDatabase.withService.mockResolvedValueOnce([]);
    await expect(runDueSearchSchedules(new Date('2026-01-01T00:00:00Z'))).resolves.toEqual([]);
    expect(schedulerDatabase.withService).toHaveBeenCalledOnce();
  });

  it('preserves all tenant claims while batching scheduler fan-out', async () => {
    schedulerDatabase.withService.mockResolvedValueOnce(Array.from({ length: 17 }, (_, index) => ({ id: `user-${index}` })));
    const claims: string[] = [];
    let active = 0;
    let maximumActive = 0;
    schedulerDatabase.withTenant.mockImplementation(async (userId: string) => {
      claims.push(userId);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 2));
      active -= 1;
      return [];
    });
    await expect(runDueSearchSchedules(new Date('2026-01-01T00:00:00Z'))).resolves.toEqual([]);
    expect(claims).toHaveLength(17);
    expect(new Set(claims).size).toBe(17);
    expect(maximumActive).toBeLessThanOrEqual(8);
  });

  it('does not silently swallow malformed per-user claim inputs', async () => {
    await expect(claimDueSearchSchedules(' ', new Date())).rejects.toThrow('Scheduler user');
    await expect(claimDueSearchSchedules('user\n-1', new Date())).rejects.toThrow('Scheduler user');
    await expect(claimDueSearchSchedules('user-1', new Date(), 0)).rejects.toThrow('Scheduler limit');
  });

  it('uses a durable mailbox claim lease across scheduler interval boundaries', async () => {
    const firstNow = new Date('2026-01-01T00:00:00Z');
    const connection = { id: 'connection-1', provider: 'GMAIL', lastSyncAt: null as Date | null, syncClaimedAt: null as Date | null };
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      emailConnection: {
        findMany: vi.fn(async () => [connection]),
        findFirst: vi.fn(async () => connection),
        update: vi.fn(async ({ data }: { data: { syncClaimedAt: Date } }) => { connection.syncClaimedAt = data.syncClaimedAt; return connection; }),
      },
      auditLog: { create: vi.fn() },
    };
    schedulerDatabase.withTenant.mockImplementation(async (_userId, callback) => callback(tx as never));
    await expect(claimDueEmailSyncs('user-1', firstNow)).resolves.toHaveLength(1);
    await expect(claimDueEmailSyncs('user-1', new Date(firstNow.getTime() + 16 * 60 * 1000))).resolves.toHaveLength(0);
    expect(tx.emailConnection.update).toHaveBeenCalledWith(expect.objectContaining({ data: { syncClaimedAt: firstNow } }));
  });
});
