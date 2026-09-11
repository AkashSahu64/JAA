import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { DiscoveryError, type DiscoveryPage, type NormalizedDiscoveryJob } from '@jobagent/job-engine';
import {
  createDiscoveryRuns,
  executeDiscoveryRun,
  listDiscoveryRuns,
  type DiscoveryExecutor,
} from './job-discovery';
import { cancelAutomationJob } from './automation-jobs';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

function job(overrides: Partial<NormalizedDiscoveryJob> = {}): NormalizedDiscoveryJob {
  const sourceJobId = overrides.sourceJobId ?? randomUUID();
  const source = overrides.source ?? 'greenhouse';
  const company = overrides.company ?? 'Goal 7 Synthetic';
  const title = overrides.title ?? 'Integration Engineer';
  const location = overrides.location ?? 'Remote';
  return {
    source,
    sourceJobId,
    company,
    title,
    location,
    description: overrides.description ?? `Synthetic description for ${sourceJobId}`,
    applicationUrl: overrides.applicationUrl ?? `https://example.invalid/apply/${sourceJobId}`,
    sourceUrl: overrides.sourceUrl ?? `https://example.invalid/jobs/${sourceJobId}`,
    fingerprint: overrides.fingerprint ?? createHash('sha256').update(`${source}:${sourceJobId}`).digest('hex'),
    provenance: overrides.provenance ?? {
      source,
      tenant: 'goal7-fixture',
      sourceJobId,
      fetchedAt: '2020-09-10T12:00:00.000Z',
      apiUrl: `https://example.invalid/api/${sourceJobId}`,
    },
  };
}

function page(jobs: NormalizedDiscoveryJob[], nextCursor?: string): DiscoveryPage {
  return {
    jobs,
    page: { pageSize: 100, returned: jobs.length, nextCursor, hasMore: Boolean(nextCursor) },
  };
}

class PagedExecutor implements DiscoveryExecutor {
  readonly cursors: Array<string | undefined> = [];
  constructor(private readonly pages: Map<string | undefined, DiscoveryPage>) {}

  async discover(input: Parameters<DiscoveryExecutor['discover']>[0]): Promise<DiscoveryPage> {
    this.cursors.push(input.cursor);
    const result = this.pages.get(input.cursor);
    if (!result) throw new Error(`Unexpected cursor: ${input.cursor ?? '<initial>'}`);
    return result;
  }
}

const failureExecutor: DiscoveryExecutor = {
  async discover() {
    throw new DiscoveryError('http', 'Synthetic provider rate limit', 'greenhouse', 429);
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// This suite intentionally never uses createAdapterExecutor or global fetch.
describeDatabase.sequential('job discovery database integration', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const fixtureJobIds = new Set<string>();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 7 Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Goal 7 Other Fixture' },
    ] });
  });

  afterAll(async () => {
    await prisma.jobDiscoveryRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    if (fixtureJobIds.size > 0) {
      await prisma.job.deleteMany({ where: { id: { in: [...fixtureJobIds] } } });
    }
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('creates one durable run and one authoritative automation job per unique source account', async () => {
    const runs = await createDiscoveryRuns(userId, {
      greenhouseBoards: [' Goal7-Greenhouse ', 'goal7-greenhouse'],
      leverCompanies: ['Goal7-Lever', ' goal7-lever '],
      ashbyBoards: ['Goal7-Ashby', 'goal7-ashby'],
      query: 'platform engineer',
      location: 'remote',
    });

    expect(runs).toHaveLength(3);
    expect(new Set(runs.map((run) => `${run.source}:${run.sourceAccount}`))).toEqual(new Set([
      'GREENHOUSE:goal7-greenhouse', 'LEVER:goal7-lever', 'ASHBY:goal7-ashby',
    ]));
    const stored = await prisma.jobDiscoveryRun.findMany({ where: { id: { in: runs.map((run) => run.id) } } });
    expect(stored).toHaveLength(3);
    expect(stored.every((run) => run.userId === userId && run.status === 'PENDING')).toBe(true);

    const jobs = await prisma.automationJob.findMany({
      where: { userId, type: 'DISCOVER_JOBS', correlationId: { in: runs.map((run) => run.id) } },
    });
    expect(jobs).toHaveLength(3);
    for (const run of runs) {
      expect(run.automationJobId).toEqual(expect.any(String));
      expect(jobs.filter((automationJob) => automationJob.correlationId === run.id)).toEqual([
        expect.objectContaining({
          id: run.automationJobId,
          status: 'AVAILABLE',
          payload: { runId: run.id },
          payloadVersion: 1,
          idempotencyKey: `discovery-run:${run.id}`,
        }),
      ]);
    }
  });

  it('does not expose discovery runs across tenants', async () => {
    const [owned] = await createDiscoveryRuns(userId, {
      greenhouseBoards: ['goal7-private'], leverCompanies: [], ashbyBoards: [],
    });
    const otherRuns = await listDiscoveryRuns(otherUserId, 100);
    expect(otherRuns.map((run) => run.id)).not.toContain(owned.id);
    expect(await listDiscoveryRuns(userId, 100)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: owned.id })]),
    );
  });

  it('persists exact provenance, resumes cursors, counters pages, and deduplicates identity and fingerprint', async () => {
    const sharedFingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const first = job({ sourceJobId: `provider-${randomUUID()}`, fingerprint: sharedFingerprint });
    const sameIdentity = job({
      ...first,
      title: 'Updated title that must not create a second item',
      provenance: { ...first.provenance, fetchedAt: '2020-09-10T12:01:00.000Z' },
    });
    const sameFingerprint = job({
      sourceJobId: `provider-${randomUUID()}`,
      title: first.title,
      fingerprint: sharedFingerprint,
      provenance: { ...first.provenance, sourceJobId: `fingerprint-${randomUUID()}` },
    });
    const unique = job({ sourceJobId: `provider-${randomUUID()}` });
    const executor = new PagedExecutor(new Map([
      [undefined, page([first], 'cursor-2')],
      ['cursor-2', page([sameIdentity, sameFingerprint, unique])],
    ]));
    const [created] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-paged-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });

    const completed = await executeDiscoveryRun(userId, created.id, executor);
    expect(executor.cursors).toEqual([undefined, 'cursor-2']);
    expect(completed).toMatchObject({
      status: 'SUCCEEDED', cursor: 'cursor-2', nextCursor: null,
      pageNumber: 2, pagesFetched: 2, itemsFetched: 4, itemsNormalized: 4,
      jobsCreated: 2, jobsUpdated: 0, itemsDuplicate: 2, itemsRejected: 0, errorCount: 0,
      startedAt: expect.any(Date), completedAt: expect.any(Date),
    });

    const items = await prisma.jobDiscoveryItem.findMany({
      where: { runId: created.id }, orderBy: [{ pageNumber: 'asc' }, { position: 'asc' }],
      include: { job: true },
    });
    expect(items).toHaveLength(3);
    items.flatMap((item) => item.jobId ? [item.jobId] : []).forEach((id) => fixtureJobIds.add(id));
    const firstItem = items.find((item) => item.sourceIdentity === first.sourceJobId)!;
    expect(firstItem).toMatchObject({
      userId, source: 'GREENHOUSE', sourceAccount: created.sourceAccount,
      sourceIdentity: first.sourceJobId, sourceUrl: first.sourceUrl,
      sourceCursor: null, pageNumber: 0, position: 0, status: 'UPSERTED',
      fingerprint: first.fingerprint, rawPayload: first, normalizedPayload: first,
      fetchedAt: new Date(first.provenance.fetchedAt),
    });
    expect(firstItem.rawContentHash).toBe(
      createHash('sha256').update(JSON.stringify(first)).digest('hex'),
    );
    expect(items.find((item) => item.sourceIdentity === sameFingerprint.sourceJobId)).toMatchObject({
      status: 'DUPLICATE', sourceCursor: 'cursor-2', pageNumber: 1,
      jobId: firstItem.jobId, duplicateOfJobId: firstItem.jobId,
    });
    expect(items.some((item) => item.sourceIdentity === sameIdentity.sourceJobId && item.pageNumber === 1)).toBe(false);
  });

  it('resolves concurrent account-qualified fingerprint ingestion deterministically', async () => {
    const account = `goal7-race-${randomUUID()}`;
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const first = job({ sourceJobId: `race-a-${randomUUID()}`, fingerprint });
    const second = job({ sourceJobId: `race-b-${randomUUID()}`, fingerprint });
    const [firstRun] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [account], leverCompanies: [], ashbyBoards: [],
    });
    const [secondRun] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [account], leverCompanies: [], ashbyBoards: [],
    });

    const results = await Promise.all([
      executeDiscoveryRun(userId, firstRun.id, { discover: async () => page([first]) }),
      executeDiscoveryRun(userId, secondRun.id, { discover: async () => page([second]) }),
    ]);

    expect(results.map(result => result.status)).toEqual(['SUCCEEDED', 'SUCCEEDED']);
    expect(results.reduce((sum, result) => sum + result.jobsCreated, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.itemsDuplicate, 0)).toBe(1);
    const items = await prisma.jobDiscoveryItem.findMany({
      where: { runId: { in: [firstRun.id, secondRun.id] } },
    });
    expect(items).toHaveLength(2);
    expect(new Set(items.map(item => item.jobId)).size).toBe(1);
    items.flatMap(item => item.jobId ? [item.jobId] : []).forEach(id => fixtureJobIds.add(id));
  });

  it('resumes a retryable failed run while leaving a nonretryable failed run terminal', async () => {
    const [retryable] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-retry-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const failed = await executeDiscoveryRun(userId, retryable.id, failureExecutor);
    expect(failed).toMatchObject({ status: 'FAILED', errorRetryable: true });

    const cursors: Array<string | undefined> = [];
    const resumed = await executeDiscoveryRun(userId, retryable.id, {
      discover: async input => { cursors.push(input.cursor); return page([]); },
    });
    expect(cursors).toEqual([undefined]);
    expect(resumed).toMatchObject({ status: 'SUCCEEDED', errorRetryable: null, errorClass: null });

    const [nonretryable] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-terminal-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const invalid = await executeDiscoveryRun(userId, nonretryable.id, {
      discover: async () => { throw new DiscoveryError('invalid-response', 'bad payload', 'greenhouse'); },
    });
    expect(invalid).toMatchObject({ status: 'FAILED', errorRetryable: false });
    const shouldNotRun = { discover: async () => { throw new Error('terminal executor ran'); } };
    await expect(executeDiscoveryRun(userId, nonretryable.id, shouldNotRun)).resolves.toMatchObject({
      id: nonretryable.id, status: 'FAILED', errorRetryable: false,
    });
  });

  it('fails safely when a provider cycles through previously seen cursors', async () => {
    const [created] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-cycle-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const executor = new PagedExecutor(new Map([
      [undefined, page([], 'cursor-a')],
      ['cursor-a', page([], 'cursor-b')],
      ['cursor-b', page([], 'cursor-a')],
    ]));

    await expect(executeDiscoveryRun(userId, created.id, executor)).resolves.toMatchObject({
      automationJobId: created.automationJobId,
      status: 'FAILED', errorClass: 'INVALID_RESPONSE', errorRetryable: false,
      pagesFetched: 3,
    });
    expect(executor.cursors).toEqual([undefined, 'cursor-a', 'cursor-b']);
  });

  it.each([
    ['completion', page([])],
    ['failure', new DiscoveryError('network', 'stale failure', 'greenhouse')],
  ])('does not let stale %s revive or overwrite a cancelled run', async (_case, outcome) => {
    const [created] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-cancel-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const started = deferred<void>();
    const released = deferred<DiscoveryPage>();
    const execution = executeDiscoveryRun(userId, created.id, {
      discover: async () => {
        started.resolve();
        if (outcome instanceof Error) {
          await released.promise;
          throw outcome;
        }
        return released.promise;
      },
    });

    await started.promise;
    await cancelAutomationJob(created.automationJobId, userId);
    released.resolve(outcome instanceof Error ? page([]) : outcome);

    await expect(execution).resolves.toMatchObject({
      id: created.id, automationJobId: created.automationJobId, status: 'CANCELLED',
      errorClass: 'CANCELLED', errorCode: 'DISCOVERY_CANCELLED',
    });
    await expect(prisma.jobDiscoveryRun.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: 'CANCELLED', pagesFetched: 0, errorClass: 'CANCELLED' });
  });

  it('records classified provider failure as a truthful retryable run', async () => {
    const [created] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`goal7-failure-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const failed = await executeDiscoveryRun(userId, created.id, failureExecutor);
    expect(failed).toMatchObject({
      status: 'FAILED', itemsFetched: 0, errorCount: 1,
      errorClass: 'RATE_LIMITED', errorCode: 'DISCOVERY_HTTP',
      errorMessage: 'Synthetic provider rate limit', errorRetryable: true,
      startedAt: expect.any(Date), heartbeatAt: expect.any(Date), completedAt: expect.any(Date),
    });
    await expect(prisma.jobDiscoveryRun.findUniqueOrThrow({ where: { id: created.id } }))
      .resolves.toMatchObject({ status: 'FAILED', errorClass: 'RATE_LIMITED', completedAt: expect.any(Date) });
  });
});
