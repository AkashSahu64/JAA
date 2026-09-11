import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const databaseUrl = process.env.DATABASE_URL;
const integrationEnabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(databaseUrl);
const describeDatabase = integrationEnabled ? describe : describe.skip;
const postgresContainer = process.env.POSTGRES_CONTAINER ?? 'job-application-agent-postgres-1';

function sql(statement: string, user = 'jobagent'): string {
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return execFileSync(
    'docker',
    ['exec', '-e', 'PGPASSWORD=jobagent-local', postgresContainer, 'psql', '-U', user, '-d', 'jobagent', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement],
    { encoding: 'utf8' },
  ).trim();
}

function asApp(statement: string): string {
  return sql(`SET ROLE jobagent_app; ${statement}`);
}

function expectSqlFailure(statement: string): void {
  expect(() => sql(statement)).toThrow();
}

describeDatabase('PostgreSQL foundation', () => {
  it('installs required extensions and records the migration', () => {
    expect(sql("SELECT extname FROM pg_extension WHERE extname IN ('pgcrypto', 'vector') ORDER BY extname"))
      .toBe('pgcrypto\nvector');
    expect(Number(sql('SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL'))).toBeGreaterThanOrEqual(2);
  });

  it('keeps the deterministic seed idempotent and synthetic', () => {
    expect(sql("SELECT email FROM users WHERE id = '00000000-0000-4000-8000-000000000001'"))
      .toBe('candidate@example.invalid');
    expect(sql("SELECT COUNT(*) FROM resumes WHERE \"userId\" = '00000000-0000-4000-8000-000000000001' AND \"isMaster\""))
      .toBe('1');
  });

  it('enforces score, version, attempt, and lease invariants', () => {
    expectSqlFailure(`UPDATE search_profiles SET "minMatchScore" = 101 WHERE id = '00000000-0000-4000-8000-000000000003'`);
    expectSqlFailure(`UPDATE resumes SET version = 0 WHERE id = '00000000-0000-4000-8000-000000000004'`);

    const jobId = randomUUID();
    const owner = '00000000-0000-4000-8000-000000000001';
    expectSqlFailure(`INSERT INTO automation_jobs (id, "userId", type, status, priority, payload, "payloadVersion", "attemptCount", "maxAttempts", "availableAt", "correlationId", "idempotencyKey", "createdAt", "updatedAt") VALUES ('${jobId}', '${owner}', 'TEST', 'LEASED', 0, '{}', 1, 0, 3, now(), '${randomUUID()}', '${randomUUID()}', now(), now())`);
  });

  it('denies cross-tenant reads and writes for the restricted role', () => {
    const tenantA = '00000000-0000-4000-8000-000000000001';
    const tenantB = randomUUID();
    sql(`INSERT INTO users (id, email, "passwordHash", name, "createdAt", "updatedAt") VALUES ('${tenantB}', '${tenantB}@example.invalid', 'fixture', 'Tenant B', now(), now())`);
    expect(asApp(`SELECT set_config('app.current_user_id', '${tenantA}', true); SELECT COUNT(*) FROM users`).split('\n').at(-1)).toBe('1');
    expect(() => asApp(`SELECT set_config('app.current_user_id', '${tenantA}', true); INSERT INTO notifications (id, "userId", type, title, message, read, "createdAt") VALUES ('${randomUUID()}', '${tenantB}', 'TEST', 'x', 'x', false, now())`)).toThrow();
  });

  it('allows only the service role to publish tenant outbox rows globally', () => {
    const tenant = '00000000-0000-4000-8000-000000000001';
    const eventId = randomUUID();
    sql(`INSERT INTO outbox_events (id, "userId", "aggregateType", "aggregateId", "eventType", payload, "schemaVersion", "correlationId", "idempotencyKey", "occurredAt", "availableAt", "publishAttempts") VALUES ('${eventId}', '${tenant}', 'RLSFixture', '${eventId}', 'fixture.created', '{}', 1, '${randomUUID()}', '${randomUUID()}', now(), now(), 0)`);
    expect(asApp(`SELECT set_config('app.current_user_id', '${randomUUID()}', true); SELECT COUNT(*) FROM outbox_events WHERE id = '${eventId}'`).split('\n').at(-1)).toBe('0');
    expect(sql(`SET ROLE jobagent_service; SELECT COUNT(*) FROM outbox_events WHERE id = '${eventId}'`).split('\n').at(-1)).toBe('1');
  });

  it('rejects ownership mismatches between applications and child records', () => {
    const owner = '00000000-0000-4000-8000-000000000001';
    const other = randomUUID();
    const jobId = randomUUID();
    const versionId = randomUUID();
    const applicationId = randomUUID();
    sql(`
      INSERT INTO users (id, email, "passwordHash", name, "createdAt", "updatedAt") VALUES ('${other}', '${other}@example.invalid', 'fixture', 'Other', now(), now()) ON CONFLICT DO NOTHING;
      INSERT INTO jobs (id, source, company, title, description, "applicationUrl", "sourceUrl", "discoveredAt", "updatedAt") VALUES ('${jobId}', 'fixture', 'Example', 'Engineer', 'fixture', 'https://example.invalid/apply', 'https://example.invalid/job', now(), now());
      INSERT INTO resume_versions (id, "resumeId", content, "generatedAt") VALUES ('${versionId}', '00000000-0000-4000-8000-000000000004', 'fixture', now());
      INSERT INTO applications (id, "userId", "jobId", "resumeVersionId", status, "createdAt", "updatedAt") VALUES ('${applicationId}', '${owner}', '${jobId}', '${versionId}', 'DISCOVERED', now(), now());
    `);
    expectSqlFailure(`INSERT INTO application_questions (id, "userId", "applicationId", label, "fieldType", risk, "createdAt", "updatedAt") VALUES ('${randomUUID()}', '${other}', '${applicationId}', 'Question', 'TEXT', 'SAFE', now(), now())`);
  });

  it('exposes transaction-scoped tenant context to application data access', async () => {
    const { withTenant } = await import('./index');
    const tenantA = '00000000-0000-4000-8000-000000000001';
    await expect(withTenant(tenantA, async (tx) => {
      const context = await tx.$queryRaw<Array<{ tenant: string }>>`SELECT app.current_user_id() AS tenant`;
      return context[0]?.tenant;
    })).resolves.toBe(tenantA);
    await expect(withTenant('', async () => undefined)).rejects.toThrow('tenant userId');
  });

  it('keeps the committed migration text free of unresolved chunk markers', () => {
    const migration = readFileSync(resolve(process.cwd(), 'packages/database/prisma/migrations/20260908210736_initial_foundation/migration.sql'), 'utf8');
    expect(migration).not.toContain('FOUNDATION_CHUNK_');
  });
});
