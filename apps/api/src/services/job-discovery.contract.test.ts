import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { DiscoveryError, type DiscoveryPage, type NormalizedDiscoveryJob } from '@jobagent/job-engine';
import {
  canonicalDiscoveryJobIdentity,
  classifyDiscoveryFailure,
  createAdapterExecutor,
  createDiscoveryRuns,
  executeDiscoveryRun,
  listDiscoveryRuns,
  type DiscoveryExecutor,
  type DiscoverySourceName,
} from './job-discovery';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const adapterCases: Array<{
  source: DiscoverySourceName;
  sourceAccount: string;
  body: unknown;
  expected: Record<string, unknown>;
}> = [
  {
    source: 'GREENHOUSE',
    sourceAccount: 'fixture-greenhouse',
    body: { jobs: [{
      id: 101,
      title: '  Senior Platform Engineer  ',
      location: { name: 'Remote' },
      departments: [{ name: 'Engineering' }],
      content: '<p>Build &amp; ship</p><br>Safely',
      updated_at: '2026-09-08T10:00:00.000Z',
      absolute_url: 'https://jobs.example.invalid/greenhouse/101#apply',
    }] },
    expected: {
      source: 'greenhouse', sourceJobId: '101', company: 'fixture-greenhouse',
      title: 'Senior Platform Engineer', location: 'Remote', department: 'Engineering',
      description: 'Build & ship \nSafely',
      applicationUrl: 'https://jobs.example.invalid/greenhouse/101',
      sourceUrl: 'https://jobs.example.invalid/greenhouse/101',
    },
  },
  {
    source: 'LEVER',
    sourceAccount: 'fixture-lever',
    body: [{
      id: 'lever-202', text: 'Backend Engineer',
      categories: { location: 'New York', department: 'Product Engineering', commitment: 'Full-time' },
      descriptionPlain: 'Own APIs', lists: [{ content: '<b>TypeScript</b> &amp; SQL' }],
      createdAt: Date.parse('2026-09-08T11:00:00.000Z'),
      hostedUrl: 'https://jobs.example.invalid/lever/202#details',
      applyUrl: 'https://jobs.example.invalid/lever/202/apply#form',
    }],
    expected: {
      source: 'lever', sourceJobId: 'lever-202', company: 'fixture-lever',
      title: 'Backend Engineer', location: 'New York', department: 'Product Engineering',
      employmentType: 'Full-time', description: 'Own APIs\nTypeScript & SQL',
      postedAt: '2026-09-08T11:00:00.000Z',
      applicationUrl: 'https://jobs.example.invalid/lever/202/apply',
      sourceUrl: 'https://jobs.example.invalid/lever/202',
    },
  },
  {
    source: 'ASHBY',
    sourceAccount: 'fixture-ashby',
    body: { jobs: [{
      id: 'ashby-303', title: 'Security Engineer', location: 'United States', workplaceType: 'Remote',
      department: 'Security', descriptionHtml: '<p>Protect&nbsp;systems</p>', employmentType: 'FullTime',
      publishedAt: '2026-09-08T12:00:00.000Z',
      jobUrl: 'https://jobs.example.invalid/ashby/303#details',
      applyUrl: 'https://jobs.example.invalid/ashby/303/application#start',
    }] },
    expected: {
      source: 'ashby', sourceJobId: 'ashby-303', company: 'fixture-ashby',
      title: 'Security Engineer', location: 'United States (Remote)', department: 'Security',
      employmentType: 'FullTime', description: 'Protect systems',
      postedAt: '2026-09-08T12:00:00.000Z',
      applicationUrl: 'https://jobs.example.invalid/ashby/303/application',
      sourceUrl: 'https://jobs.example.invalid/ashby/303',
    },
  },
];

function discoveryJob(sourceJobId: string, fingerprint = createHash('sha256').update(sourceJobId).digest('hex')): NormalizedDiscoveryJob {
  return {
    source: 'greenhouse', sourceJobId, company: 'Contract Fixture', title: 'Platform Engineer',
    location: 'Remote', description: `Synthetic fixture ${sourceJobId}`,
    applicationUrl: `https://apply.example.invalid/${sourceJobId}`,
    sourceUrl: `https://jobs.example.invalid/${sourceJobId}`, fingerprint,
    provenance: {
      source: 'greenhouse', tenant: 'contract-fixture', sourceJobId,
      fetchedAt: '2026-09-08T12:00:00.000Z', apiUrl: `https://api.example.invalid/${sourceJobId}`,
    },
  };
}
function page(jobs: NormalizedDiscoveryJob[], nextCursor?: string): DiscoveryPage {
  return { jobs, page: { pageSize: 100, returned: jobs.length, hasMore: Boolean(nextCursor), nextCursor } };
}

describe('job discovery contracts without external I/O', () => {
  it.each(adapterCases)('normalizes a synthetic $source fixture', async ({ source, sourceAccount, body, expected }) => {
    const requests: URL[] = [];
    const fetch: typeof globalThis.fetch = async input => {
      requests.push(new URL(input instanceof Request ? input.url : input.toString()));
      return jsonResponse(body);
    };

    const result = await createAdapterExecutor(fetch).discover({ source, sourceAccount, pageSize: 100 });

    expect(requests).toHaveLength(1);
    expect(requests[0].protocol).toBe('https:');
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject(expected);
    expect(result.jobs[0].provenance).toMatchObject({
      source: String(source).toLowerCase(), tenant: sourceAccount,
      sourceJobId: expected.sourceJobId, apiUrl: requests[0].toString(),
    });
    expect(result.jobs[0].provenance.fetchedAt).toEqual(expect.any(String));
    expect(result.jobs[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.page).toEqual({ pageSize: 100, returned: 1, hasMore: false, nextCursor: undefined });
  });

  it('deduplicates canonical provider identity only within an account', () => {
    const canonical = canonicalDiscoveryJobIdentity(' Tenant-A ', 'job/42');
    expect(canonical).toBe(canonicalDiscoveryJobIdentity('tenant-a', 'job/42'));
    expect(canonical).not.toBe(canonicalDiscoveryJobIdentity('tenant-b', 'job/42'));
    expect(canonicalDiscoveryJobIdentity('a:b', 'c')).not.toBe(canonicalDiscoveryJobIdentity('a', 'b:c'));
  });

  it.each([
    [new DiscoveryError('http', 'limited', 'greenhouse', 429), 'RATE_LIMITED', true],
    [new DiscoveryError('http', 'unauthenticated', 'lever', 401), 'AUTHENTICATION', false],
    [new DiscoveryError('http', 'forbidden', 'ashby', 403), 'AUTHORIZATION', false],
    [new DiscoveryError('http', 'missing', 'greenhouse', 404), 'NOT_FOUND', false],
    [new DiscoveryError('timeout', 'slow', 'lever'), 'TIMEOUT', true],
    [new DiscoveryError('network', 'offline', 'ashby'), 'NETWORK', true],
    [new DiscoveryError('invalid-response', 'malformed', 'greenhouse'), 'INVALID_RESPONSE', false],
    [new DiscoveryError('aborted', 'cancelled', 'lever'), 'CANCELLED', false],
  ])('classifies an adapter failure without losing retry semantics', (error, errorClass, errorRetryable) => {
    expect(classifyDiscoveryFailure(error)).toMatchObject({
      errorClass, errorMessage: error.message, errorRetryable,
    });
  });
});

const databaseEnabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = databaseEnabled ? describe : describe.skip;

describeDatabase.sequential('job discovery persistence contracts', () => {
  it('persists adapter-normalization rejections as traceable rejected items', async () => {
    const rejectedUserId = randomUUID();
    await prisma.user.create({ data: { id: rejectedUserId, email: `${rejectedUserId}@example.invalid`, passwordHash: 'fixture', name: 'Rejected Item Fixture' } });
    try {
      const [run] = await createDiscoveryRuns(rejectedUserId, {
        greenhouseBoards: [`rejected-item-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
      });
      const result = await executeDiscoveryRun(rejectedUserId, run.id, {
        discover: async () => ({
          jobs: [],
          rejections: [{
            source: 'greenhouse', providerIndex: 0, raw: { malformed: true },
            error: { kind: 'invalid-response', message: 'greenhouse job id is missing' },
          }],
          page: { pageSize: 100, returned: 0, hasMore: false },
        }),
      });
      expect(result).toMatchObject({ status: 'PARTIAL', itemsFetched: 1, itemsRejected: 1, errorCount: 1 });
      await expect(prisma.jobDiscoveryItem.findFirstOrThrow({ where: { runId: run.id } })).resolves.toMatchObject({
        status: 'REJECTED', sourceIdentity: null, errorClass: 'NORMALIZATION',
        errorCode: 'DISCOVERY_INVALID_RESPONSE', errorRetryable: false, rawPayload: { malformed: true },
      });
    } finally {
      await prisma.jobDiscoveryRun.deleteMany({ where: { userId: rejectedUserId } });
      await prisma.user.delete({ where: { id: rejectedUserId } });
    }
  });

  const userId = randomUUID();
  const otherUserId = randomUUID();
  const jobIds = new Set<string>();

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'synthetic-fixture', name: 'Contract Tenant' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'synthetic-fixture', name: 'Other Tenant' },
    ] });
  });

  afterAll(async () => {
    await prisma.jobDiscoveryRun.deleteMany({ where: { userId: { in: [userId, otherUserId] } } });
    if (jobIds.size > 0) await prisma.job.deleteMany({ where: { id: { in: [...jobIds] } } });
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it('isolates listing and execution across tenants', async () => {
    const [owned] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`contract-private-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });

    expect((await listDiscoveryRuns(otherUserId, 100)).map(run => run.id)).not.toContain(owned.id);
    await expect(executeDiscoveryRun(otherUserId, owned.id, {
      discover: async () => { throw new Error('cross-tenant executor must not run'); },
    })).rejects.toThrow('Discovery run not found');

    const stored = await prisma.jobDiscoveryRun.findUniqueOrThrow({ where: { id: owned.id } });
    expect(stored).toMatchObject({ userId, status: 'PENDING', pagesFetched: 0 });
  });

  it('resumes at the committed next cursor after a simulated worker interruption', async () => {
    const firstJob = discoveryJob(`resume-first-${randomUUID()}`);
    const secondJob = discoveryJob(`resume-second-${randomUUID()}`);
    const [run] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [`contract-resume-${randomUUID()}`], leverCompanies: [], ashbyBoards: [],
    });
    const firstAttemptCursors: Array<string | undefined> = [];
    const interrupted: DiscoveryExecutor = {
      discover: async input => {
        firstAttemptCursors.push(input.cursor);
        if (!input.cursor) return page([firstJob], 'cursor-2');
        throw new DiscoveryError('network', 'Synthetic interruption', 'greenhouse');
      },
    };

    const partial = await executeDiscoveryRun(userId, run.id, interrupted);
    expect(firstAttemptCursors).toEqual([undefined, 'cursor-2']);
    expect(partial).toMatchObject({
      status: 'PARTIAL', nextCursor: 'cursor-2', pagesFetched: 1, itemsFetched: 1,
      errorClass: 'NETWORK', errorRetryable: true,
    });

    const resumedCursors: Array<string | undefined> = [];
    const resumed = await executeDiscoveryRun(userId, run.id, {
      discover: async input => { resumedCursors.push(input.cursor); return page([secondJob]); },
    });
    expect(resumedCursors).toEqual(['cursor-2']);
    expect(resumed).toMatchObject({ status: 'SUCCEEDED', pagesFetched: 2, itemsFetched: 2, jobsCreated: 2 });

    const persisted = await prisma.jobDiscoveryItem.findMany({ where: { runId: run.id } });
    persisted.flatMap(item => item.jobId ? [item.jobId] : []).forEach(id => jobIds.add(id));
  });

  it('keeps repeated ingestion idempotent within a run and across runs', async () => {
    const sourceJobId = `idempotent-${randomUUID()}`;
    const fixture = discoveryJob(sourceJobId);
    const account = `contract-idempotent-${randomUUID()}`;
    const [firstRun] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [account], leverCompanies: [], ashbyBoards: [],
    });
    const duplicatePage = page([fixture, { ...fixture }]);

    const first = await executeDiscoveryRun(userId, firstRun.id, { discover: async () => duplicatePage });
    expect(first).toMatchObject({ jobsCreated: 1, jobsUpdated: 0, itemsDuplicate: 1, itemsFetched: 2 });

    const firstItems = await prisma.jobDiscoveryItem.findMany({ where: { runId: firstRun.id } });
    expect(firstItems).toHaveLength(1);
    expect(firstItems[0]).toMatchObject({ sourceIdentity: sourceJobId, status: 'UPSERTED' });
    if (firstItems[0].jobId) jobIds.add(firstItems[0].jobId);

    const replay = await executeDiscoveryRun(userId, firstRun.id, {
      discover: async () => { throw new Error('terminal run must not fetch twice'); },
    });
    expect(replay).toMatchObject({ id: firstRun.id, jobsCreated: 1, itemsFetched: 2 });

    const [secondRun] = await createDiscoveryRuns(userId, {
      greenhouseBoards: [account], leverCompanies: [], ashbyBoards: [],
    });
    const second = await executeDiscoveryRun(userId, secondRun.id, { discover: async () => page([fixture]) });
    expect(second).toMatchObject({ jobsCreated: 0, jobsUpdated: 1, itemsDuplicate: 0, itemsFetched: 1 });

    const jobs = await prisma.job.findMany({
      where: { source: 'GREENHOUSE', sourceJobId: canonicalDiscoveryJobIdentity(account, sourceJobId) },
    });
    expect(jobs).toHaveLength(1);
    jobs.forEach(job => jobIds.add(job.id));
  });
});
