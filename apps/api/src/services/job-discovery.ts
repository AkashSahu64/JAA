import { createHash, randomUUID } from 'node:crypto';
import { Prisma, withTenant, type TenantTransaction } from '@jobagent/database';
import {
  AshbyPublicApiAdapter,
  DiscoveryError,
  type DiscoveryItemRejection,
  GreenhousePublicApiAdapter,
  LeverPublicApiAdapter,
  type DiscoveryPage,
  type NormalizedDiscoveryJob,
  type PublicApiAdapter,
} from '@jobagent/job-engine';
import { executeIdempotentCommand } from './idempotency';
import { cancelAutomationJob } from './automation-jobs';

export type DiscoverySourceName = 'GREENHOUSE' | 'LEVER' | 'ASHBY';
export type DiscoveryRunState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED';
export type DiscoveryErrorClass =
  | 'AUTHENTICATION' | 'AUTHORIZATION' | 'RATE_LIMITED' | 'TIMEOUT' | 'NETWORK'
  | 'SOURCE_UNAVAILABLE' | 'NOT_FOUND' | 'INVALID_RESPONSE' | 'NORMALIZATION'
  | 'VALIDATION' | 'PERSISTENCE' | 'CANCELLED' | 'INTERNAL';

export interface DiscoveryAccounts {
  greenhouseBoards: string[];
  leverCompanies: string[];
  ashbyBoards: string[];
  query?: string;
  location?: string;
}

export interface DiscoveryRunSummary {
  id: string;
  automationJobId: string;
  source: DiscoverySourceName;
  sourceAccount: string;
  status: DiscoveryRunState;
  query: unknown;
  cursor: string | null;
  nextCursor: string | null;
  pageNumber: number;
  pagesFetched: number;
  itemsFetched: number;
  itemsNormalized: number;
  jobsCreated: number;
  jobsUpdated: number;
  itemsDuplicate: number;
  itemsRejected: number;
  errorCount: number;
  errorClass: DiscoveryErrorClass | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorRetryable: boolean | null;
  errorRetryAfterMs: number | null;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface DiscoveryExecutor {
  discover(input: {
    source: DiscoverySourceName;
    sourceAccount: string;
    query?: string;
    location?: string;
    cursor?: string;
    pageSize: number;
    signal?: AbortSignal;
  }): Promise<DiscoveryPage>;
}

export interface DiscoveryExecutionAuthority {
  automationJobId: string;
  workerId: string;
  deliveryGeneration: number;
  dispatchAttempt?: number;
}

const MAX_DISCOVERY_PAGES = 1_000;
const MAX_DISCOVERY_ITEMS = 100_000;
const MAX_DISCOVERY_DURATION_MS = 30 * 60 * 1_000;

const RUN_SELECT = {
  id: true, source: true, sourceAccount: true, status: true, query: true,
  cursor: true, nextCursor: true, pageNumber: true, pagesFetched: true,
  itemsFetched: true, itemsNormalized: true, jobsCreated: true, jobsUpdated: true,
  itemsDuplicate: true, itemsRejected: true, errorCount: true, errorClass: true,
  errorCode: true, errorMessage: true, errorRetryable: true, errorDetails: true, startedAt: true,
  heartbeatAt: true, completedAt: true, createdAt: true, updatedAt: true,
} as const;

export function createAdapterExecutor(fetch?: typeof globalThis.fetch): DiscoveryExecutor {
  return {
    async discover(input) {
      const options = fetch ? { fetch } : {};
      let adapter: PublicApiAdapter;
      if (input.source === 'GREENHOUSE') adapter = new GreenhousePublicApiAdapter(input.sourceAccount, options);
      else if (input.source === 'LEVER') adapter = new LeverPublicApiAdapter(input.sourceAccount, options);
      else adapter = new AshbyPublicApiAdapter(input.sourceAccount, options);
      return adapter.discover({
        query: input.query,
        location: input.location,
        cursor: input.cursor,
        pageSize: input.pageSize,
        signal: input.signal,
      });
    },
  };
}

export async function createDiscoveryRuns(
  userId: string,
  input: DiscoveryAccounts,
  requestKey: string = randomUUID(),
): Promise<DiscoveryRunSummary[]> {
  const normalized = normalizeDiscoveryRequest(input);
  const result = await executeIdempotentCommand({
    userId,
    scope: 'job-discovery:create',
    key: requestKey,
    request: normalized as unknown as Prisma.InputJsonValue,
  }, async tx => {
    const summaries = await createDiscoveryRunsInTransaction(tx, userId, normalized, requestKey);
    return { responseCode: 202, responseBody: summariesToJson(summaries) };
  });
  return summariesFromJson(result.responseBody as Prisma.JsonValue);
}

export async function createDiscoveryRunsInTransaction(
  tx: TenantTransaction,
  userId: string,
  input: DiscoveryAccounts,
  requestKey: string,
): Promise<DiscoveryRunSummary[]> {
  const runs: DiscoveryRunSummary[] = [];
  for (const account of uniqueAccounts(input)) {
    const runRequestKey = `${requestKey}:${randomUUID()}`;
    const run = await tx.jobDiscoveryRun.create({
      data: {
        userId,
        source: account.source,
        sourceAccount: account.sourceAccount,
        requestKey: runRequestKey,
        query: { query: input.query ?? null, location: input.location ?? null },
      },
      select: RUN_SELECT,
    });
    const automationJob = await tx.automationJob.create({
      data: {
        userId,
        type: 'DISCOVER_JOBS',
        status: 'AVAILABLE',
        payload: { runId: run.id },
        payloadVersion: 1,
        correlationId: run.id,
        idempotencyKey: `discovery-run:${run.id}`,
      },
    });
    runs.push(toSummary(run, automationJob.id));
  }
  return runs;
}

export async function listDiscoveryRuns(userId: string, limit: number): Promise<DiscoveryRunSummary[]> {
  return withTenant(userId, async tx => {
    const runs = await tx.jobDiscoveryRun.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: RUN_SELECT,
    });
    const automationJobs = await tx.automationJob.findMany({
      where: { userId, type: 'DISCOVER_JOBS', correlationId: { in: runs.map(run => run.id) } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, correlationId: true },
    });
    const automationJobIds = new Map(automationJobs.map(job => [job.correlationId, job.id]));
    return runs.flatMap(run => {
      const automationJobId = automationJobIds.get(run.id);
      return automationJobId ? [toSummary(run, automationJobId)] : [];
    });
  });
}

export async function getDiscoveryRun(userId: string, runId: string): Promise<DiscoveryRunSummary | null> {
  return withTenant(userId, async tx => {
    const run = await tx.jobDiscoveryRun.findFirst({ where: { id: runId, userId }, select: RUN_SELECT });
    if (!run) return null;
    const automationJob = await tx.automationJob.findFirst({
      where: { userId, type: 'DISCOVER_JOBS', correlationId: runId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return automationJob ? toSummary(run, automationJob.id) : null;
  });
}

export async function cancelDiscoveryRun(userId: string, runId: string): Promise<DiscoveryRunSummary | null> {
  const automationJob = await withTenant(userId, tx => tx.automationJob.findFirst({
    where: { userId, type: 'DISCOVER_JOBS', correlationId: runId },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  }));
  if (!automationJob) return null;
  await cancelAutomationJob(automationJob.id, userId);
  return getDiscoveryRun(userId, runId);
}

export async function executeDiscoveryRun(
  userId: string,
  runId: string,
  executor: DiscoveryExecutor = createAdapterExecutor(),
  signal?: AbortSignal,
  authority?: DiscoveryExecutionAuthority,
): Promise<DiscoveryRunSummary> {
  const loaded = await withTenant(userId, async tx => {
    const [run, automationJob] = await Promise.all([
      tx.jobDiscoveryRun.findFirst({ where: { id: runId, userId } }),
      tx.automationJob.findFirst({
        where: {
          userId, type: 'DISCOVER_JOBS', correlationId: runId,
          ...(authority ? { id: authority.automationJobId } : {}),
        },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      }),
    ]);
    return { run, automationJob };
  });
  const found = loaded.run;
  if (!found || !loaded.automationJob) throw new Error('Discovery run not found');
  const automationJobId = loaded.automationJob.id;
  if (isTerminal(found.status as DiscoveryRunState, found.errorRetryable)) return toSummary(found, automationJobId);

  const startedAt = found.startedAt ?? new Date();
  const claimed = await withTenant(userId, tx => tx.jobDiscoveryRun.updateMany({
    where: {
      id: runId,
      userId,
      status: found.status,
      updatedAt: found.updatedAt,
      NOT: { status: 'CANCELLED' },
    },
    data: { status: 'RUNNING', startedAt, heartbeatAt: new Date(), completedAt: null },
  }));
  if (claimed.count !== 1) {
    const current = await withTenant(userId, tx => tx.jobDiscoveryRun.findFirstOrThrow({ where: { id: runId, userId } }));
    return toSummary(current, automationJobId);
  }
  let run = await withTenant(userId, tx => tx.jobDiscoveryRun.findFirstOrThrow({ where: { id: runId, userId } }));

  try {
    const executionStartedAt = Date.now();
    const cursorHistory = new Set<string>();
    let pagesThisExecution = 0;
    let itemsThisExecution = 0;
    let hasMore = true;
    while (hasMore) {
      throwIfAborted(signal);
      enforceExecutionBounds(executionStartedAt, pagesThisExecution, itemsThisExecution);
      const query = asQuery(run.query);
      const requestCursor = run.nextCursor ?? run.cursor ?? undefined;
      const cursorKey = requestCursor ?? '<initial>';
      if (cursorHistory.has(cursorKey)) {
        throw new DiscoveryError('invalid-response', `${run.source} returned a repeated paging cursor`, sourceName(run.source));
      }
      cursorHistory.add(cursorKey);
      const page = await executor.discover({
        source: run.source as DiscoverySourceName,
        sourceAccount: run.sourceAccount,
        query: query.query,
        location: query.location,
        cursor: requestCursor,
        pageSize: 100,
        signal,
      });
      throwIfAborted(signal);
      validatePaging(run.source, requestCursor, page);
      pagesThisExecution += 1;
      itemsThisExecution += page.jobs.length + (page.rejections?.length ?? 0);
      enforceExecutionBounds(executionStartedAt, pagesThisExecution, itemsThisExecution);
      run = await persistPage(userId, run, page, authority);
      hasMore = page.page.hasMore;
    }
    throwIfAborted(signal);
    const status: DiscoveryRunState = run.itemsRejected > 0 ? 'PARTIAL' : 'SUCCEEDED';
    const completedAt = new Date();
    await withTenant(userId, async tx => {
      await assertExecutionAuthority(tx, userId, runId, authority, completedAt);
      await tx.jobDiscoveryRun.update({
        where: { id: runId },
        data: {
          status, completedAt, heartbeatAt: completedAt,
          errorCount: run.itemsRejected,
          errorDetails: Prisma.DbNull,
          ...(run.itemsRejected === 0 ? {
            errorClass: null, errorCode: null, errorMessage: null, errorRetryable: null,
          } : {
            errorClass: 'NORMALIZATION', errorCode: 'DISCOVERY_ITEM_REJECTED',
            errorMessage: `${run.itemsRejected} discovery item${run.itemsRejected === 1 ? '' : 's'} could not be normalized or persisted`,
            errorRetryable: false,
          }),
        },
      });
    });
    run = await loadDiscoveryRun(userId, runId);
  } catch (error) {
    if (error instanceof InactiveDiscoveryRunError) {
      return toSummary(await loadDiscoveryRun(userId, runId), automationJobId);
    }
    const failure = classifyDiscoveryFailure(error);
    const status: DiscoveryRunState = failure.errorClass === 'CANCELLED'
      ? 'CANCELLED'
      : run.itemsFetched > 0 ? 'PARTIAL' : 'FAILED';
    const completedAt = new Date();
    try {
      await withTenant(userId, async tx => {
        await assertExecutionAuthority(tx, userId, runId, authority, completedAt);
        await tx.jobDiscoveryRun.update({
          where: { id: runId },
          data: {
            status, completedAt, heartbeatAt: completedAt,
            errorCount: { increment: 1 }, errorClass: failure.errorClass,
            errorCode: failure.errorCode, errorMessage: failure.errorMessage,
            errorRetryable: failure.errorRetryable,
            errorDetails: failure.errorRetryAfterMs === null
              ? Prisma.DbNull
              : { retryAfterMs: failure.errorRetryAfterMs },
          },
        });
      });
    } catch (persistError) {
      if (!(persistError instanceof InactiveDiscoveryRunError)) throw persistError;
    }
    run = await loadDiscoveryRun(userId, runId);
  }
  return toSummary(run, automationJobId);
}

async function persistPage(
  userId: string,
  run: any,
  page: DiscoveryPage,
  authority?: DiscoveryExecutionAuthority,
): Promise<any> {
  let created = 0;
  let updated = 0;
  let duplicate = 0;
  let rejected = 0;
  let errors = 0;
  const pageNumber = run.pageNumber;

  for (const [position, job] of page.jobs.entries()) {
    const rawPayload = json(job);
    const hash = createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
    try {
      const outcome = await persistDiscoveryItemAtomic(
        userId, run, job, rawPayload, hash, pageNumber, position, authority,
      );
      if (outcome === 'duplicate') duplicate += 1;
      else if (outcome === 'updated') updated += 1;
      else created += 1;
    } catch (error) {
      if (error instanceof InactiveDiscoveryRunError) throw error;
      rejected += 1;
      errors += 1;
      const failure = classifyDiscoveryFailure(error, 'PERSISTENCE');
      await recordRejectedDiscoveryItem(userId, run, job, rawPayload, hash, pageNumber, position, failure, authority);
    }
  }
  for (const rejection of page.rejections ?? []) {
    rejected += 1;
    errors += 1;
    await recordNormalizationRejection(userId, run, rejection, pageNumber, authority);
  }

  return withTenant(userId, async tx => {
    await assertExecutionAuthority(tx, userId, run.id, authority);
    return tx.jobDiscoveryRun.update({
      where: { id: run.id },
      data: {
        cursor: run.nextCursor ?? run.cursor, nextCursor: page.page.nextCursor ?? null,
        pageNumber: { increment: 1 }, pagesFetched: { increment: 1 },
        itemsFetched: { increment: page.jobs.length + (page.rejections?.length ?? 0) }, itemsNormalized: { increment: page.jobs.length },
        jobsCreated: { increment: created }, jobsUpdated: { increment: updated },
        itemsDuplicate: { increment: duplicate }, itemsRejected: { increment: rejected },
        errorCount: { increment: errors }, heartbeatAt: new Date(),
        ...(errors > 0 ? {
          errorClass: 'PERSISTENCE' as const,
          errorCode: 'DISCOVERY_ITEM_PERSISTENCE',
          errorMessage: `${errors} discovery item${errors === 1 ? '' : 's'} could not be persisted`,
          errorRetryable: false,
        } : {}),
      },
    });
  });
}

async function persistDiscoveryItemAtomic(
  userId: string,
  run: any,
  job: NormalizedDiscoveryJob,
  rawPayload: Prisma.InputJsonValue,
  hash: string,
  pageNumber: number,
  position: number,
  authority?: DiscoveryExecutionAuthority,
): Promise<'created' | 'updated' | 'duplicate'> {
  try {
    return await withTenant(userId, async tx => {
      await assertExecutionAuthority(tx, userId, run.id, authority);
      const existingItem = await tx.jobDiscoveryItem.findUnique({
        where: { runId_sourceIdentity: { runId: run.id, sourceIdentity: job.sourceJobId } },
      });
      if (existingItem) return 'duplicate' as const;
      return persistDiscoveryItem(tx, userId, run, job, rawPayload, hash, pageNumber, position);
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    return withTenant(userId, async tx => {
      await assertExecutionAuthority(tx, userId, run.id, authority);
      const existingItem = await tx.jobDiscoveryItem.findUnique({
        where: { runId_sourceIdentity: { runId: run.id, sourceIdentity: job.sourceJobId } },
      });
      if (existingItem) return 'duplicate' as const;
      const identityJob = await tx.job.findUnique({
        where: {
          source_sourceJobId: {
            source: job.source,
            sourceJobId: accountQualifiedSourceJobId(run.sourceAccount, job.sourceJobId),
          },
        },
        select: { id: true },
      });
      const fingerprintJob = await tx.job.findUnique({
        where: { fingerprint: accountQualifiedFingerprint(job.source, run.sourceAccount, job.fingerprint) },
        select: { id: true },
      });
      const duplicateJob = identityJob ?? fingerprintJob;
      if (!duplicateJob) throw error;
      await createDiscoveryItem(tx, userId, run, job, rawPayload, hash, pageNumber, position, {
        status: 'DUPLICATE', jobId: duplicateJob.id, duplicateOfJobId: duplicateJob.id,
      });
      return 'duplicate' as const;
    });
  }
}

async function persistDiscoveryItem(
  tx: TenantTransaction,
  userId: string,
  run: any,
  job: NormalizedDiscoveryJob,
  rawPayload: Prisma.InputJsonValue,
  hash: string,
  pageNumber: number,
  position: number,
): Promise<'created' | 'updated' | 'duplicate'> {
  const qualifiedSourceJobId = accountQualifiedSourceJobId(run.sourceAccount, job.sourceJobId);
  const qualifiedFingerprint = accountQualifiedFingerprint(job.source, run.sourceAccount, job.fingerprint);
  const existingJob = await tx.job.findUnique({
    where: { source_sourceJobId: { source: job.source, sourceJobId: qualifiedSourceJobId } },
    select: { id: true },
  });
  const fingerprintJob = await tx.job.findUnique({
    where: { fingerprint: qualifiedFingerprint },
    select: { id: true },
  });
  if (fingerprintJob && fingerprintJob.id !== existingJob?.id) {
    await createDiscoveryItem(tx, userId, run, job, rawPayload, hash, pageNumber, position, {
      status: 'DUPLICATE', jobId: fingerprintJob.id, duplicateOfJobId: fingerprintJob.id,
    });
    return 'duplicate';
  }
  const persisted = await tx.job.upsert({
    where: { source_sourceJobId: { source: job.source, sourceJobId: qualifiedSourceJobId } },
    create: toJobData(job, run.sourceAccount), update: toJobData(job, run.sourceAccount), select: { id: true },
  });
  await createDiscoveryItem(tx, userId, run, job, rawPayload, hash, pageNumber, position, {
    status: 'UPSERTED', jobId: persisted.id,
  });
  return existingJob ? 'updated' : 'created';
}

async function createDiscoveryItem(
  tx: TenantTransaction,
  userId: string,
  run: any,
  job: NormalizedDiscoveryJob,
  rawPayload: Prisma.InputJsonValue,
  hash: string,
  pageNumber: number,
  position: number,
  outcome: { status: 'UPSERTED' | 'DUPLICATE'; jobId: string; duplicateOfJobId?: string },
): Promise<void> {
  await tx.jobDiscoveryItem.create({ data: {
    userId, runId: run.id, source: run.source, sourceAccount: run.sourceAccount,
    sourceIdentity: job.sourceJobId, sourceUrl: job.sourceUrl, sourceCursor: run.nextCursor ?? run.cursor,
    pageNumber, position, fetchedAt: new Date(job.provenance.fetchedAt), rawPayload,
    rawContentHash: hash, normalizedPayload: rawPayload, fingerprint: job.fingerprint,
    status: outcome.status, jobId: outcome.jobId, duplicateOfJobId: outcome.duplicateOfJobId,
    processedAt: new Date(),
  } });
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function recordNormalizationRejection(
  userId: string,
  run: any,
  rejection: DiscoveryItemRejection,
  pageNumber: number,
  authority?: DiscoveryExecutionAuthority,
): Promise<void> {
  const rawPayload = json(rejection.raw);
  const hash = createHash('sha256').update(JSON.stringify(rawPayload)).digest('hex');
  await withTenant(userId, async tx => {
    await assertExecutionAuthority(tx, userId, run.id, authority);
    await tx.jobDiscoveryItem.create({ data: {
      userId, runId: run.id, source: run.source, sourceAccount: run.sourceAccount,
      sourceIdentity: null, sourceUrl: `https://${rejection.source}.invalid/normalization-rejection`,
      sourceCursor: run.nextCursor ?? run.cursor, pageNumber, position: rejection.providerIndex,
      fetchedAt: new Date(), rawPayload, rawContentHash: hash, status: 'REJECTED',
      errorClass: 'NORMALIZATION', errorCode: 'DISCOVERY_INVALID_RESPONSE',
      errorMessage: rejection.error.message.slice(0, 1_000), errorRetryable: false, processedAt: new Date(),
    } });
  });
}

async function recordRejectedDiscoveryItem(
  userId: string,
  run: any,
  job: NormalizedDiscoveryJob,
  rawPayload: Prisma.InputJsonValue,
  hash: string,
  pageNumber: number,
  position: number,
  failure: ReturnType<typeof classifyDiscoveryFailure>,
  authority?: DiscoveryExecutionAuthority,
): Promise<void> {
  await withTenant(userId, async tx => {
    await assertExecutionAuthority(tx, userId, run.id, authority);
    await tx.jobDiscoveryItem.create({ data: {
      userId, runId: run.id, source: run.source, sourceAccount: run.sourceAccount,
      sourceIdentity: job.sourceJobId, sourceUrl: job.sourceUrl, sourceCursor: run.nextCursor ?? run.cursor,
      pageNumber, position, fetchedAt: new Date(job.provenance.fetchedAt), rawPayload,
      rawContentHash: hash, normalizedPayload: rawPayload, fingerprint: job.fingerprint,
      status: 'FAILED', errorClass: failure.errorClass, errorCode: failure.errorCode,
      errorMessage: failure.errorMessage, errorRetryable: failure.errorRetryable, processedAt: new Date(),
    } });
  });
}

function normalizeDiscoveryRequest(input: DiscoveryAccounts): DiscoveryAccounts {
  const normalizeAccounts = (accounts: string[], label: string) => {
    if (!Array.isArray(accounts)) throw new Error(`${label} must be an array`);
    const normalized = accounts.map(account => account.normalize('NFKC').trim().toLowerCase());
    if (normalized.length > 20 || normalized.some(account => !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(account))) {
      throw new Error(`${label} must contain at most 20 safe source account slugs`);
    }
    return [...new Set(normalized)];
  };
  const normalizeFilter = (value: unknown, label: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 200) throw new Error(`${label} must be at most 200 characters`);
    return value.trim() || undefined;
  };
  const normalized = {
    greenhouseBoards: normalizeAccounts(input.greenhouseBoards, 'greenhouseBoards'),
    leverCompanies: normalizeAccounts(input.leverCompanies, 'leverCompanies'),
    ashbyBoards: normalizeAccounts(input.ashbyBoards, 'ashbyBoards'),
    query: normalizeFilter(input.query, 'query'),
    location: normalizeFilter(input.location, 'location'),
  };
  if (normalized.greenhouseBoards.length + normalized.leverCompanies.length + normalized.ashbyBoards.length === 0) {
    throw new Error('At least one source account is required');
  }
  return normalized;
}

function summariesToJson(summaries: DiscoveryRunSummary[]): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(summaries)) as Prisma.InputJsonValue;
}

function summariesFromJson(value: Prisma.JsonValue): DiscoveryRunSummary[] {
  if (!Array.isArray(value)) throw new Error('Stored discovery response is invalid');
  return value as unknown as DiscoveryRunSummary[];
}

function uniqueAccounts(input: DiscoveryAccounts): Array<{ source: DiscoverySourceName; sourceAccount: string }> {
  const accounts = [
    ...input.greenhouseBoards.map(sourceAccount => ({ source: 'GREENHOUSE' as const, sourceAccount })),
    ...input.leverCompanies.map(sourceAccount => ({ source: 'LEVER' as const, sourceAccount })),
    ...input.ashbyBoards.map(sourceAccount => ({ source: 'ASHBY' as const, sourceAccount })),
  ];
  const seen = new Set<string>();
  return accounts.filter(account => {
    const normalized = account.sourceAccount.trim().toLowerCase();
    const key = `${account.source}:${normalized}`;
    if (seen.has(key)) return false;
    seen.add(key);
    account.sourceAccount = normalized;
    return true;
  });
}

export function canonicalDiscoveryJobIdentity(sourceAccount: string, sourceIdentity: string): string {
  return accountQualifiedSourceJobId(sourceAccount, sourceIdentity);
}

function accountQualifiedSourceJobId(sourceAccount: string, sourceIdentity: string): string {
  const account = Buffer.from(sourceAccount.normalize('NFKC').trim().toLowerCase(), 'utf8').toString('base64url');
  const identity = Buffer.from(sourceIdentity.normalize('NFKC').trim(), 'utf8').toString('base64url');
  return `${account}.${identity}`;
}

function accountQualifiedFingerprint(source: string, sourceAccount: string, fingerprint: string): string {
  return createHash('sha256').update(`${source}${sourceAccount}${fingerprint}`, 'utf8').digest('hex');
}

function toJobData(job: NormalizedDiscoveryJob, sourceAccount: string) {
  return {
    source: job.source,
    sourceJobId: accountQualifiedSourceJobId(sourceAccount, job.sourceJobId),
    company: job.company,
    title: job.title,
    normalizedTitle: job.title.normalize('NFKC').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim(),
    location: job.location,
    description: job.description,
    employmentType: job.employmentType,
    postedAt: parseDate(job.postedAt),
    applicationUrl: job.applicationUrl,
    sourceUrl: job.sourceUrl,
    fingerprint: accountQualifiedFingerprint(job.source, sourceAccount, job.fingerprint),
    isActive: true,
  };
}

function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function asQuery(value: unknown): { query?: string; location?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    query: typeof record.query === 'string' ? record.query : undefined,
    location: typeof record.location === 'string' ? record.location : undefined,
  };
}

export function validatePaging(source: string, requestCursor: string | undefined, page: DiscoveryPage): void {
  if (page.page.hasMore && (!page.page.nextCursor || page.page.nextCursor === requestCursor)) {
    throw new DiscoveryError('invalid-response', `${source} returned invalid paging metadata`, sourceName(source));
  }
}

function sourceName(source: string): 'greenhouse' | 'lever' | 'ashby' {
  return source.toLowerCase() as 'greenhouse' | 'lever' | 'ashby';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DiscoveryError('aborted', 'Discovery execution was cancelled', 'greenhouse', undefined, {
    cause: signal.reason,
  });
}

function isTerminal(status: DiscoveryRunState, errorRetryable: boolean | null): boolean {
  if (status === 'FAILED') return errorRetryable !== true;
  return status === 'SUCCEEDED' || status === 'CANCELLED';
}

class InactiveDiscoveryRunError extends Error {}

async function assertExecutionAuthority(
  tx: TenantTransaction,
  userId: string,
  runId: string,
  authority?: DiscoveryExecutionAuthority,
  now = new Date(),
): Promise<void> {
  const run = await tx.jobDiscoveryRun.findFirst({
    where: { id: runId, userId, status: 'RUNNING' },
    select: { id: true },
  });
  if (!run) throw new InactiveDiscoveryRunError();
  if (!authority) return;
  const job = await tx.automationJob.findFirst({
    where: {
      id: authority.automationJobId,
      userId,
      correlationId: runId,
      type: 'DISCOVER_JOBS',
      status: 'LEASED',
      leaseOwner: authority.workerId,
      deliveryGeneration: authority.deliveryGeneration,
      leaseExpiresAt: { gt: now },
      ...(authority.dispatchAttempt === undefined ? {} : { attemptCount: authority.dispatchAttempt }),
    },
    select: { id: true },
  });
  if (!job) throw new InactiveDiscoveryRunError();
}

function enforceExecutionBounds(startedAt: number, pages: number, items: number): void {
  if (pages > MAX_DISCOVERY_PAGES || items > MAX_DISCOVERY_ITEMS || Date.now() - startedAt > MAX_DISCOVERY_DURATION_MS) {
    throw new DiscoveryError('invalid-response', 'Discovery execution exceeded its bounded work limits', 'greenhouse');
  }
}

async function loadDiscoveryRun(userId: string, runId: string) {
  return withTenant(userId, tx => tx.jobDiscoveryRun.findFirstOrThrow({ where: { id: runId, userId } }));
}

function toSummary(run: any, automationJobId: string): DiscoveryRunSummary {
  const result: Record<string, unknown> = { automationJobId };
  for (const key of Object.keys(RUN_SELECT)) {
    if (key !== 'errorDetails') result[key] = run[key];
  }
  result.errorRetryAfterMs = retryAfterFromDetails(run.errorDetails);
  return result as unknown as DiscoveryRunSummary;
}

function retryAfterFromDetails(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return validRetryAfterMs((value as Record<string, unknown>).retryAfterMs);
}

function validRetryAfterMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function classifyDiscoveryFailure(error: unknown, fallback: DiscoveryErrorClass = 'INTERNAL') {
  let errorClass = fallback;
  let errorCode = 'DISCOVERY_INTERNAL';
  let retryable = false;
  if (error instanceof DiscoveryError) {
    errorCode = `DISCOVERY_${error.kind.toUpperCase().replace('-', '_')}`;
    if (error.kind === 'aborted') errorClass = 'CANCELLED';
    else if (error.kind === 'timeout') errorClass = 'TIMEOUT';
    else if (error.kind === 'network') errorClass = 'NETWORK';
    else if (error.kind === 'invalid-response') errorClass = 'INVALID_RESPONSE';
    else if (error.status === 401) errorClass = 'AUTHENTICATION';
    else if (error.status === 403) errorClass = 'AUTHORIZATION';
    else if (error.status === 404) errorClass = 'NOT_FOUND';
    else if (error.status === 429) errorClass = 'RATE_LIMITED';
    else errorClass = 'SOURCE_UNAVAILABLE';
    retryable = errorClass === 'TIMEOUT' || errorClass === 'NETWORK' || errorClass === 'RATE_LIMITED' || errorClass === 'SOURCE_UNAVAILABLE';
  }
  return {
    errorClass,
    errorCode,
    errorMessage: error instanceof Error ? error.message.slice(0, 1000) : 'Unknown discovery failure',
    errorRetryable: retryable,
    errorRetryAfterMs: validRetryAfterMs(
      error && typeof error === 'object' ? (error as { retryAfterMs?: unknown }).retryAfterMs : undefined,
    ),
  };
}

