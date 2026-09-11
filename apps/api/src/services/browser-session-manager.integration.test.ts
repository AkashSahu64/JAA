import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '@jobagent/database';
import { BrowserSessionError, BrowserSessionManager } from './browser-session-manager';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

type FakePage = {
  goto: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
};

function fakeBrowser() {
  const page: FakePage = {
    goto: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
  };
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => undefined),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  };
  return { browser, context, page };
}

describeDatabase.sequential('browser session persistence', () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const jobId = randomUUID();
  const resumeId = randomUUID();
  const resumeVersionId = randomUUID();
  const applicationId = randomUUID();
  const sharedKey = randomUUID();
  const fake = fakeBrowser();
  const manager = new BrowserSessionManager(
    async () => fake.browser as never,
    async () => ['93.184.216.34'],
  );

  const input = (overrides: Partial<Parameters<BrowserSessionManager['start']>[0]> = {}) => ({
    userId,
    applicationId,
    targetUrl: 'https://careers.example.com/apply',
    allowedHosts: ['careers.example.com'],
    workerId: 'worker-1',
    correlationId: 'browser-correlation-1',
    idempotencyKey: sharedKey,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  });

  beforeAll(async () => {
    await prisma.user.createMany({ data: [
      { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Browser Fixture' },
      { id: otherUserId, email: `${otherUserId}@example.invalid`, passwordHash: 'fixture', name: 'Other Browser Fixture' },
    ] });
    await prisma.job.create({ data: {
      id: jobId, source: 'fixture', sourceJobId: randomUUID(), company: 'Example',
      title: 'Engineer', description: 'fixture', applicationUrl: 'https://example.invalid/apply',
      sourceUrl: 'https://example.invalid/job',
    } });
    await prisma.resume.create({ data: {
      id: resumeId, userId, name: 'Fixture resume', content: 'Approved fixture facts only.',
    } });
    await prisma.resumeVersion.create({ data: {
      id: resumeVersionId, resumeId, content: 'Approved fixture facts only.',
    } });
    await prisma.application.create({ data: {
      id: applicationId, userId, jobId, resumeVersionId, status: 'APPLICATION_STARTED',
    } });
  });

  afterAll(async () => {
    await manager.shutdown();
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.job.deleteMany({ where: { id: jobId } });
    await prisma.$disconnect();
  });

  it('persists a tenant-idempotent session and lifecycle evidence', async () => {
    const created = await manager.start(input());
    const replayed = await manager.start(input());
    expect(created.replayed).toBe(false);
    expect(replayed).toMatchObject({ replayed: true, session: { id: created.session.id } });
    expect(fake.browser.newContext).toHaveBeenCalledTimes(1);
    await expect(prisma.browserSessionReference.findUniqueOrThrow({
      where: { id: created.session.id },
    })).resolves.toMatchObject({
      userId,
      applicationId,
      status: 'ACTIVE',
      initialUrl: 'https://careers.example.com/apply',
      idempotencyKey: sharedKey,
    });
    await expect(prisma.auditLog.count({
      where: { userId, action: 'BROWSER_SESSION_STARTED', resourceId: created.session.id },
    })).resolves.toBe(1);
    await expect(prisma.outboxEvent.count({
      where: { userId, aggregateId: created.session.id, eventType: 'browser-session.started' },
    })).resolves.toBe(1);

    await manager.close(userId, created.session.externalRef, input().correlationId);
    await expect(prisma.browserSessionReference.findUniqueOrThrow({
      where: { id: created.session.id },
    })).resolves.toMatchObject({ status: 'CLOSED', closedAt: expect.any(Date) });
  });

  it('rejects altered idempotent requests and tenant-crossing applications', async () => {
    await expect(manager.start(input({ targetUrl: 'https://careers.example.com/other' })))
      .rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<BrowserSessionError>);
    await expect(manager.start(input({
      userId: otherUserId,
      applicationId,
      idempotencyKey: randomUUID(),
      correlationId: randomUUID(),
    }))).rejects.toMatchObject({ code: 'NOT_FOUND' } satisfies Partial<BrowserSessionError>);
  });
});
