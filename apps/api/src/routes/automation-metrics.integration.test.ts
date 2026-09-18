import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { generateToken } from '@jobagent/security';
import { createApp } from '../app';
import { closeApplicationQueueMetrics } from '../services/queue-metrics';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('live tenant automation metrics', () => {
  const userId = randomUUID();
  const app = createApp();
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  beforeAll(async () => {
    process.env.JWT_SECRET ??= 'fixture-jwt-secret-for-integration-only-0123456789';
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Metrics Fixture' } });
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await closeApplicationQueueMetrics();
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('returns authenticated tenant-scoped operational metrics', async () => {
    const response = await fetch(`${baseUrl}/api/automation/metrics`, { headers: { authorization: `Bearer ${generateToken({ userId, email: `${userId}@example.invalid` })}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; data: { jobs: unknown[]; attempts: unknown[]; failures: unknown[]; browserSessions: unknown[]; pendingVerification: { pendingCount: number }; alerts: unknown[] } };
    expect(body).toMatchObject({ success: true, data: { jobs: [], attempts: [], failures: [], browserSessions: [], pendingVerification: { pendingCount: 0 }, alerts: expect.any(Array) } });
  });
});
