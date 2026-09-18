import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const integrationEnabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(databaseUrl);
const describeDatabase = integrationEnabled ? describe : describe.skip;
const postgresContainer = process.env.POSTGRES_CONTAINER ?? 'job-application-agent-postgres-1';
const owner = '00000000-0000-4000-8000-000000000001';
const prisma = new PrismaClient();
const createdJobIds = new Set<string>();
const insertedDiscoveryRunIds = new Set<string>();

afterAll(async () => {
  if (integrationEnabled) {
    // Order matters: discovery items and runs reference jobs, so they go first.
    if (insertedDiscoveryRunIds.size > 0) {
      const runIds = [...insertedDiscoveryRunIds].map(id => `'${id}'`).join(',');
      sql(`DELETE FROM job_discovery_items WHERE "runId" IN (${runIds}); DELETE FROM job_discovery_runs WHERE id IN (${runIds})`);
    }
    if (createdJobIds.size > 0) {
      await prisma.job.deleteMany({ where: { id: { in: [...createdJobIds] } } });
    }
  }
  await prisma.$disconnect();
});

function sql(statement: string): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return execFileSync(
    'docker',
    ['exec', '-e', 'PGPASSWORD=jobagent-local', postgresContainer, 'psql', '-U', 'jobagent', '-d', 'jobagent', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim();
}

function expectSqlFailure(statement: string): void {
  expect(() => sql(statement)).toThrow();
}

function createRun(id = randomUUID()): string {
  sql(`INSERT INTO job_discovery_runs (id, "userId", source, "sourceAccount", "requestKey", query, "createdAt", "updatedAt") VALUES ('${id}', '${owner}', 'GREENHOUSE', 'fixture-account', '${randomUUID()}', '{}', now(), now())`);
  return id;
}

function createJobStatement(id: string): string {
  return `INSERT INTO jobs (id, source, company, title, description, "applicationUrl", "sourceUrl", "discoveredAt", "updatedAt") VALUES ('${id}', 'fixture', 'Example', 'Engineer', 'fixture', 'https://example.invalid/apply/${id}', 'https://example.invalid/job/${id}', now(), now())`;
}

function requireSqlFailures(statements: string[]): string {
  const values = statements.map((statement) => `$expected_failure$${statement}$expected_failure$`).join(', ');
  return `DO $require_failures$
DECLARE
  candidate text;
  failed boolean;
BEGIN
  FOREACH candidate IN ARRAY ARRAY[${values}] LOOP
    failed := false;
    BEGIN
      EXECUTE candidate;
    EXCEPTION WHEN OTHERS THEN
      failed := true;
    END;
    IF NOT failed THEN
      RAISE EXCEPTION 'Expected SQL statement to fail: %', candidate;
    END IF;
  END LOOP;
END
$require_failures$`;
}

function itemValues(runId: string, status: string, jobId: string | null, duplicateOfJobId: string | null, sourceIdentity?: string | null): string {
  const itemId = randomUUID();
  const nullable = (value: string | null) => value === null ? 'NULL' : `'${value}'`;
  const persistedSourceIdentity = sourceIdentity === undefined ? itemId : sourceIdentity;
  return `('${itemId}', '${runId}', '${owner}', 'GREENHOUSE', 'fixture-account', ${nullable(persistedSourceIdentity)}, 'https://example.invalid/source/${itemId}', 0, 0, '{}', '${itemId}', '${status}', ${nullable(jobId)}, ${nullable(duplicateOfJobId)}, ${status === 'FETCHED' ? 'NULL' : 'now()'}, now(), now())`;
}

function insertItem(values: string): string {
  return sql(insertStatement(values));
}

function insertStatement(values: string): string {
  return `INSERT INTO job_discovery_items (id, "runId", "userId", source, "sourceAccount", "sourceIdentity", "sourceUrl", "pageNumber", position, "rawPayload", "rawContentHash", status, "jobId", "duplicateOfJobId", "processedAt", "createdAt", "updatedAt") VALUES ${values} RETURNING id`;
}

describeDatabase('Goal 7 discovery database hardening', () => {
  it('enforces child ownership and source identity with the composite foreign key', () => {
    const runId = createRun();
    const itemId = randomUUID();
    expectSqlFailure(`INSERT INTO job_discovery_items (id, "runId", "userId", source, "sourceAccount", "sourceIdentity", "sourceUrl", "pageNumber", position, "rawPayload", "rawContentHash", "createdAt", "updatedAt") VALUES ('${itemId}', '${runId}', '${owner}', 'LEVER', 'fixture-account', '${itemId}', 'https://example.invalid/source/${itemId}', 0, 0, '{}', '${itemId}', now(), now())`);

    expect(insertItem(itemValues(runId, 'FETCHED', null, null))).toMatch(/[0-9a-f-]{36}/);
    expectSqlFailure(`UPDATE job_discovery_runs SET "sourceAccount" = 'changed-account' WHERE id = '${runId}'`);
    expect(sql(`DELETE FROM job_discovery_runs WHERE id = '${runId}'; SELECT COUNT(*) FROM job_discovery_items WHERE "runId" = '${runId}'`)).toBe('0');
  });

  it('allows missing source identity only for REJECTED items', () => {
    const runId = createRun();
    const canonicalJobId = randomUUID();
    sql(createJobStatement(canonicalJobId));

    const rejectedItemId = insertItem(itemValues(runId, 'REJECTED', null, null, null));
    expect(sql(`SELECT "sourceIdentity" IS NULL FROM job_discovery_items WHERE id = '${rejectedItemId}'`)).toBe('t');

    sql(requireSqlFailures([
      insertStatement(itemValues(runId, 'FETCHED', null, null, null)),
      insertStatement(itemValues(runId, 'NORMALIZED', null, null, null)),
      insertStatement(itemValues(runId, 'UPSERTED', null, null, null)),
      insertStatement(itemValues(runId, 'DUPLICATE', canonicalJobId, canonicalJobId, null)),
      insertStatement(itemValues(runId, 'FAILED', null, null, null)),
      insertStatement(itemValues(runId, 'FETCHED', null, null, '   ')),
    ]));

    sql(`DELETE FROM job_discovery_runs WHERE id = '${runId}'; DELETE FROM jobs WHERE id = '${canonicalJobId}'`);
  });

  it('requires complete and equal DUPLICATE provenance', () => {
    const runId = randomUUID();
    const canonicalJobId = randomUUID();
    const otherJobId = randomUUID();
    // These rows are inserted by raw SQL rather than through `createdJobIds`, so the
    // shared cleanup below cannot see them. `job_discovery_items` references both
    // jobs, so the items and the run must be removed before the jobs themselves.
    insertedDiscoveryRunIds.add(runId);
    createdJobIds.add(canonicalJobId);
    createdJobIds.add(otherJobId);
    sql(`
      INSERT INTO job_discovery_runs (id, "userId", source, "sourceAccount", "requestKey", query, "createdAt", "updatedAt") VALUES ('${runId}', '${owner}', 'GREENHOUSE', 'fixture-account', '${randomUUID()}', '{}', now(), now());
      ${createJobStatement(canonicalJobId)};
      ${createJobStatement(otherJobId)};
    `);

    sql(requireSqlFailures([
      insertStatement(itemValues(runId, 'DUPLICATE', null, null)),
      insertStatement(itemValues(runId, 'DUPLICATE', canonicalJobId, null)),
      insertStatement(itemValues(runId, 'DUPLICATE', null, canonicalJobId)),
      insertStatement(itemValues(runId, 'DUPLICATE', canonicalJobId, otherJobId)),
      insertStatement(itemValues(runId, 'UPSERTED', canonicalJobId, canonicalJobId)),
    ]));

    const duplicateItemId = insertItem(itemValues(runId, 'DUPLICATE', canonicalJobId, canonicalJobId));
    expect(duplicateItemId).toMatch(/[0-9a-f-]{36}/);
    expectSqlFailure(`DELETE FROM jobs WHERE id = '${canonicalJobId}'`);
    expect(sql(`SELECT "jobId" = "duplicateOfJobId" FROM job_discovery_items WHERE id = '${duplicateItemId}'`)).toBe('t');
  });

  it('serializes concurrent canonical inserts by fingerprint while retaining provider identity uniqueness', async () => {
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const ids = [randomUUID(), randomUUID()];
    ids.forEach(id => createdJobIds.add(id));
    const create = (id: string, sourceJobId: string) => prisma.job.create({ data: {
      id, source: 'greenhouse', sourceJobId, fingerprint,
      company: 'Goal 7 Race Fixture', title: 'Database Engineer', description: 'fixture',
      applicationUrl: `https://example.invalid/apply/${id}`,
      sourceUrl: `https://example.invalid/job/${id}`,
    } });

    const results = await Promise.allSettled([
      create(ids[0], `account-a.${randomUUID()}`),
      create(ids[1], `account-b.${randomUUID()}`),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.job.count({ where: { fingerprint } })).toBe(1);

    const providerIdentity = `account.${randomUUID()}`;
    const providerIds = [randomUUID(), randomUUID()];
    providerIds.forEach(id => createdJobIds.add(id));
    const providerCreates = await Promise.allSettled(providerIds.map((id, index) => prisma.job.create({ data: {
      id, source: 'lever', sourceJobId: providerIdentity,
      fingerprint: createHash('sha256').update(`${fingerprint}:${index}`).digest('hex'),
      company: 'Goal 7 Provider Fixture', title: 'Platform Engineer', description: 'fixture',
      applicationUrl: `https://example.invalid/provider/apply/${id}`,
      sourceUrl: `https://example.invalid/provider/job/${id}`,
    } })));
    expect(providerCreates.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(providerCreates.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await prisma.job.count({ where: { source: 'lever', sourceJobId: providerIdentity } })).toBe(1);
  });

  it('atomically converges concurrent fingerprint upserts on one canonical job', async () => {
    const fingerprint = createHash('sha256').update(randomUUID()).digest('hex');
    const ids = [randomUUID(), randomUUID()];
    ids.forEach(id => createdJobIds.add(id));
    const upsert = (id: string) => prisma.job.upsert({
      where: { fingerprint },
      create: {
        id, source: 'ashby', sourceJobId: `account.${id}`, fingerprint,
        company: 'Goal 7 Upsert Fixture', title: 'Reliability Engineer', description: 'fixture',
        applicationUrl: `https://example.invalid/upsert/apply/${id}`,
        sourceUrl: `https://example.invalid/upsert/job/${id}`,
      },
      update: { isActive: true },
      select: { id: true, fingerprint: true },
    });

    const persisted = await Promise.all([upsert(ids[0]), upsert(ids[1])]);
    expect(new Set(persisted.map(job => job.id)).size).toBe(1);
    expect(persisted.every(job => job.fingerprint === fingerprint)).toBe(true);
    expect(await prisma.job.count({ where: { fingerprint } })).toBe(1);
  });
});
