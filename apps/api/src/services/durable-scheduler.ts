import { withService, withTenant } from '@jobagent/database';
import { nextScheduledRun, SchedulerError } from './scheduler';
export { SchedulerError } from './scheduler';
import { createDiscoveryRunsInTransaction, type DiscoveryAccounts } from './job-discovery';
import { createAutomationJobInTransaction, type CreateAutomationJobInput } from './automation-jobs';

const emailSyncIntervalMs = 15 * 60 * 1000;
const emailSyncClaimLeaseMs = 30 * 60 * 1000;
const MAX_SCHEDULER_SHUTDOWN_TIMEOUT_MS = 120_000;
const MAX_SCHEDULER_TENANT_CONCURRENCY = 8;

async function runTenantClaims<T>(userIds: readonly string[], claim: (userId: string) => Promise<T[]>): Promise<T[]> {
  const results: T[] = [];
  for (let offset = 0; offset < userIds.length; offset += MAX_SCHEDULER_TENANT_CONCURRENCY) {
    const batch = userIds.slice(offset, offset + MAX_SCHEDULER_TENANT_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(userId => claim(userId)));
    for (const result of settled) {
      if (result.status === 'fulfilled') results.push(...result.value);
      else throw result.reason;
    }
  }
  return results;
}

export interface ScheduleApplicationRunInput {
  userId: string;
  applicationId: string;
  automationRunId?: string;
  runAt: Date;
  correlationId: string;
  idempotencyKey: string;
  maxAttempts?: number;
}

export function validateApplicationRunAt(runAt: Date, now = new Date()): Date {
  if (!(runAt instanceof Date) || !Number.isFinite(runAt.getTime())) throw new SchedulerError('Application run time is invalid');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SchedulerError('Scheduler time is invalid');
  if (runAt.getTime() < now.getTime()) throw new SchedulerError('Application run time cannot be in the past');
  if (runAt.getTime() > now.getTime() + 90 * 24 * 60 * 60 * 1_000) throw new SchedulerError('Application run time is too far in the future');
  return runAt;
}

/** Queue a tenant-owned, provider-specific application form run for a durable future slot. */
export async function scheduleApplicationRun(input: ScheduleApplicationRunInput, now = new Date()) {
  if (!safeSchedulerUserId(input.userId)) throw new SchedulerError('Scheduler user is invalid');
  if (!safeSchedulerIdentifier(input.applicationId) || !safeSchedulerIdentifier(input.correlationId) || !safeSchedulerIdentifier(input.idempotencyKey)) throw new SchedulerError('Application schedule identifiers are invalid');
  const runAt = validateApplicationRunAt(input.runAt, now);
  return withTenant(input.userId, async tx => {
  const application = await tx.application.findFirst({
    where: { id: input.applicationId, userId: input.userId },
    select: { id: true, status: true, job: { select: { source: true } }, automationRun: { select: { id: true, status: true } } },
  });
  if (!application) throw new SchedulerError('Application not found');
  if (application.status !== 'APPLICATION_STARTED') {
    throw new SchedulerError('Application is not eligible for a scheduled form run');
  }
  if (input.automationRunId && (!application.automationRun || application.automationRun.id !== input.automationRunId
    || !['RUNNING', 'PAUSED'].includes(application.automationRun.status))) {
    throw new SchedulerError('Automation run is not an active owner-bound run');
  }
  const provider = application.job.source.trim().toUpperCase();
  const type = provider === 'GREENHOUSE' ? 'COMPLETE_GREENHOUSE_APPLICATION'
    : provider === 'LEVER' ? 'COMPLETE_LEVER_APPLICATION' : null;
  if (!type) throw new SchedulerError('Application provider does not support scheduled runs');
  const queued = await createAutomationJobInTransaction(tx, {
    userId: input.userId,
    applicationId: input.applicationId,
    automationRunId: input.automationRunId,
    type,
    payload: { applicationId: input.applicationId },
    payloadVersion: 1,
    maxAttempts: input.maxAttempts ?? 3,
    availableAt: runAt,
    correlationId: input.correlationId,
    idempotencyKey: input.idempotencyKey,
  } satisfies CreateAutomationJobInput);
  if (!queued.replayed) {
    await tx.auditLog.create({ data: {
      userId: input.userId,
      action: 'APPLICATION_RUN_SCHEDULED',
      resource: 'Application',
      resourceId: input.applicationId,
      details: { automationJobId: queued.id, provider, runAt: runAt.toISOString(), idempotencyKey: input.idempotencyKey },
    } });
  }
  await tx.outboxEvent.upsert({
    where: { idempotencyKey: `application-run-scheduled:${queued.id}` },
    create: {
      userId: input.userId,
      aggregateType: 'Application',
      aggregateId: input.applicationId,
      eventType: 'application.run.scheduled',
      payload: { applicationId: input.applicationId, automationJobId: queued.id, provider, runAt: runAt.toISOString() },
      schemaVersion: 1,
      correlationId: input.correlationId,
      idempotencyKey: `application-run-scheduled:${queued.id}`,
    },
    update: {},
  });
  return queued;
  });
}

export interface ClaimedSearchSchedule {
  profileId: string;
  scheduledAt: Date;
  nextRunAt: Date | null;
  schedule: string;
  discoveryRunIds: string[];
}

export interface ClaimedEmailSync {
  connectionId: string;
  provider: 'GMAIL' | 'MICROSOFT_GRAPH';
  scheduledAt: Date;
  automationJobId: string;
}

function safeSchedulerUserId(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value === value.trim()
    && value.length <= 200 && !value.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function safeSchedulerIdentifier(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim()) && value === value.trim()
    && value.length <= 200 && !value.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function parseDiscoveryAccounts(value: unknown): DiscoveryAccounts | null {
  if (!Array.isArray(value)) return null;
const accounts = { greenhouseBoards: [], leverCompanies: [], ashbyBoards: [] } as DiscoveryAccounts;
  const seen = { GREENHOUSE: new Set<string>(), LEVER: new Set<string>(), ASHBY: new Set<string>() };
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    const source = record.source;
    const account = typeof record.account === 'string' ? record.account.trim() : '';
    if (!account || account.length > 200 || account.split('').some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
      || (source !== 'GREENHOUSE' && source !== 'LEVER' && source !== 'ASHBY')) return null;
    if (seen[source].has(account)) continue;
    seen[source].add(account);
    if (source === 'GREENHOUSE') accounts.greenhouseBoards.push(account);
    if (source === 'LEVER') accounts.leverCompanies.push(account);
    if (source === 'ASHBY') accounts.ashbyBoards.push(account);
    if (accounts.greenhouseBoards.length + accounts.leverCompanies.length + accounts.ashbyBoards.length > 60) return null;
  }
  return accounts.greenhouseBoards.length || accounts.leverCompanies.length || accounts.ashbyBoards.length ? accounts : null;
}

/** Claim due durable schedule slots; the caller creates the corresponding work in its transaction. */
export async function claimDueSearchSchedules(userId: string, now = new Date(), limit = 20): Promise<ClaimedSearchSchedule[]> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SchedulerError('Scheduler time is invalid');
  if (!safeSchedulerUserId(userId)) throw new SchedulerError('Scheduler user is invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SchedulerError('Scheduler limit is invalid');
  return withTenant(userId, async tx => {
    const profiles = await tx.searchProfile.findMany({
      where: { userId, isActive: true, OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }] },
      orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const claimed: ClaimedSearchSchedule[] = [];
    for (const profile of profiles) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:schedule:${profile.id}`}, 0))`;
      const current = await tx.searchProfile.findFirst({ where: { id: profile.id, userId, isActive: true } });
      if (!current || (current.nextRunAt && current.nextRunAt > now)) continue;
      const accounts = parseDiscoveryAccounts(current.discoveryAccounts);
      if (!accounts) continue;
      const scheduledAt = current.nextRunAt ?? now;
      const nextRunAt = nextScheduledRun(current.schedule as 'ONCE' | 'HOURLY' | 'EVERY_3_HOURS' | 'DAILY' | 'WEEKLY' | 'CUSTOM', current.customCron, scheduledAt, current.timeZone);
      await tx.searchProfile.update({ where: { id: current.id }, data: { lastRunAt: now, nextRunAt, isActive: nextRunAt !== null } });
      const runs = await createDiscoveryRunsInTransaction(tx, userId, { ...accounts, query: current.targetRoles.join(' '), location: current.cities[0] }, `scheduled-discovery:${current.id}:${scheduledAt.toISOString()}`);
      claimed.push({ profileId: current.id, scheduledAt, nextRunAt, schedule: current.schedule, discoveryRunIds: runs.map(run => run.id) });
    }
    return claimed;
  });
}

export async function runDueSearchSchedules(now = new Date(), perUserLimit = 20): Promise<ClaimedSearchSchedule[]> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SchedulerError('Scheduler time is invalid');
  if (!Number.isSafeInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 100) throw new SchedulerError('Scheduler per-user limit is invalid');
  const users = await withService(tx => tx.user.findMany({ where: { isActive: true }, select: { id: true } }));
  return runTenantClaims(users.map(user => user.id), userId => claimDueSearchSchedules(userId, now, perUserLimit));
}

/** Queue one bounded, owner-scoped mailbox sync per due active connection. */
export async function claimDueEmailSyncs(userId: string, now = new Date(), limit = 20): Promise<ClaimedEmailSync[]> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SchedulerError('Scheduler time is invalid');
  if (!safeSchedulerUserId(userId)) throw new SchedulerError('Scheduler user is invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SchedulerError('Scheduler limit is invalid');
  return withTenant(userId, async tx => {
    const connections = await tx.emailConnection.findMany({
      where: { userId, status: 'ACTIVE', provider: { in: ['GMAIL', 'MICROSOFT_GRAPH'] }, AND: [
        { OR: [{ lastSyncAt: null }, { lastSyncAt: { lte: new Date(now.getTime() - emailSyncIntervalMs) } }] },
        { OR: [{ syncClaimedAt: null }, { syncClaimedAt: { lte: new Date(now.getTime() - emailSyncClaimLeaseMs) } }] },
      ] },
      orderBy: [{ lastSyncAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, provider: true, lastSyncAt: true, syncClaimedAt: true },
    });
    const claimed: ClaimedEmailSync[] = [];
    for (const connection of connections) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:email-sync:${connection.id}`}, 0))`;
      const current = await tx.emailConnection.findFirst({ where: { id: connection.id, userId, status: 'ACTIVE', provider: connection.provider } });
      if (!current || (current.lastSyncAt && current.lastSyncAt.getTime() > now.getTime() - emailSyncIntervalMs)
        || (current.syncClaimedAt && current.syncClaimedAt.getTime() > now.getTime() - emailSyncClaimLeaseMs)) continue;
      const scheduledAt = current.lastSyncAt ?? now;
      const queued = await createAutomationJobInTransaction(tx, {
        userId,
        type: 'SYNC_EMAIL_CONNECTION',
        payload: { connectionId: current.id, provider: current.provider },
        payloadVersion: 1,
        maxAttempts: 3,
        // Mailbox claims are due immediately. Leaving the optional schedule
        // timestamp unset keeps the idempotency payload stable across the
        // PostgreSQL timestamp precision boundary on concurrent replays.
        availableAt: undefined,
        correlationId: `scheduled-email-sync:${current.id}:${now.toISOString()}`,
        idempotencyKey: `scheduled-email-sync:${current.id}:${Math.floor(now.getTime() / emailSyncIntervalMs)}`,
      } satisfies CreateAutomationJobInput);
      await tx.emailConnection.update({ where: { id: current.id }, data: { syncClaimedAt: now } });
      if (!queued.replayed) {
        await tx.auditLog.create({ data: {
          userId,
          action: 'EMAIL_SYNC_SCHEDULED',
          resource: 'EmailConnection',
          resourceId: current.id,
          details: { provider: current.provider, automationJobId: queued.id, scheduledAt: scheduledAt.toISOString(), runAt: now.toISOString() },
        } });
        claimed.push({ connectionId: current.id, provider: current.provider as 'GMAIL' | 'MICROSOFT_GRAPH', scheduledAt, automationJobId: queued.id });
      }
    }
    return claimed;
  });
}

export async function runDueEmailSyncs(now = new Date(), perUserLimit = 20): Promise<ClaimedEmailSync[]> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new SchedulerError('Scheduler time is invalid');
  if (!Number.isSafeInteger(perUserLimit) || perUserLimit < 1 || perUserLimit > 100) throw new SchedulerError('Scheduler per-user limit is invalid');
  const users = await withService(tx => tx.user.findMany({ where: { isActive: true }, select: { id: true } }));
  return runTenantClaims(users.map(user => user.id), userId => claimDueEmailSyncs(userId, now, perUserLimit));
}

export function startDurableScheduler(options: { intervalMs: number; shutdownTimeoutMs?: number; onError?: (error: unknown) => void } = { intervalMs: 60_000 }): { close: () => Promise<void> } {
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1_000) throw new Error('Scheduler interval must be at least one second');
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1_000 || shutdownTimeoutMs > MAX_SCHEDULER_SHUTDOWN_TIMEOUT_MS) throw new Error('Scheduler shutdown timeout must be between one second and two minutes');
  let running = false;
  let closed = false;
  const tick = async () => {
    if (closed || running) return;
    running = true;
    try {
      const results = await Promise.allSettled([runDueSearchSchedules(), runDueEmailSyncs()]);
      for (const result of results) if (result.status === 'rejected') options.onError?.(result.reason);
    } finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, options.intervalMs);
  timer.unref();
  return { close: async () => {
    closed = true;
    clearInterval(timer);
    const deadline = Date.now() + shutdownTimeoutMs;
    while (running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (running) throw new Error('Durable scheduler did not stop before the shutdown timeout');
  } };
}
