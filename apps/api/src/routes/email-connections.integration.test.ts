import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@jobagent/database';
import { generateToken } from '@jobagent/security';
import { createApp } from '../app';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('authenticated email connection routes', () => {
  const app = createApp();
  const userId = randomUUID();
  const gmailConnectionId = randomUUID();
  const imapConnectionId = randomUUID();
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';
  let token = '';
  let headers: Record<string, string>;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.invalid`, passwordHash: 'fixture', name: 'Email Route Fixture' } });
    await prisma.emailConnection.createMany({ data: [
      { id: gmailConnectionId, userId, provider: 'GMAIL', accountLabel: 'gmail@example.invalid', scopes: ['mail.read'], status: 'ACTIVE' },
      { id: imapConnectionId, userId, provider: 'IMAP', accountLabel: 'imap@example.invalid', scopes: ['mail.read'], status: 'ACTIVE' },
    ] });
    token = generateToken({ userId, email: `${userId}@example.invalid` });
    headers = { authorization: `Bearer ${token}` };
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Email connections fixture server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('lists tenant-owned connections', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: Array<{ id: string; provider: string; status: string }> };
    expect(body.success).toBe(true);
    const ids = body.data.map(c => c.id).sort();
    expect(ids).toEqual([gmailConnectionId, imapConnectionId].sort());
  });

  it('requires authentication', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections`);
    expect(res.status).toBe(401);
  });

  it('rejects a foreign credential reference during consent', async () => {
    const credentialId = randomUUID();
    const res = await fetch(`${baseUrl}/api/email-connections`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'GMAIL', accountLabel: 'oauth@example.invalid', scopes: ['https://mail.google.com/'], credentialRef: credentialId }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid email consent');
  });

  it('rejects unsupported providers or malformed consent input', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'OUTLOOK', accountLabel: 'a@b.test', scopes: [] }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects sync for a non-syncable provider (IMAP)', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${imapConnectionId}/sync`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'sync-key-12345678' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.error).toContain('cannot be synchronized');
  });

  it('rejects sync with a malformed idempotency key', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'too-short' },
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body.error).toContain('Idempotency-Key');
  });

  it('rejects sync for a non-existent connection', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${randomUUID()}/sync`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'non-existent-conn-key' },
    });
    expect(res.status).toBe(404);
  });

  it('accepts a valid sync request and queues a durable sync job', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'first-sync-key-12345' },
    });
    expect(res.status).toBe(202);
    const body = await res.json() as { success: boolean; data: { id: string; status: string; replayed: boolean } };
    expect(body).toMatchObject({ success: true, data: { status: 'AVAILABLE', replayed: false } });
  });

  it('replays the same sync request idempotently with matching correlation', async () => {
    const syncKey = 'idempotent-replay-key-';
    const correlationId = `email-sync-correlation-${randomUUID()}`;
    const replayHeaders = { ...headers, 'idempotency-key': syncKey, 'x-correlation-id': correlationId };
    const first = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: replayHeaders,
    });
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { success: boolean; data: { id: string; status: string; replayed: boolean } };
    expect(firstBody).toMatchObject({ success: true, data: { status: 'AVAILABLE', replayed: false } });

    const second = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: replayHeaders,
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { success: boolean; data: { id: string; status: string; replayed: boolean } };
    expect(secondBody).toMatchObject({ success: true, data: { id: firstBody.data.id, replayed: true } });
  });

  it('does not allow cross-tenant connection access', async () => {
    const otherUser = randomUUID();
    await prisma.user.create({ data: { id: otherUser, email: `${otherUser}@example.invalid`, passwordHash: 'fixture', name: 'Other User' } });
    const otherToken = generateToken({ userId: otherUser, email: `${otherUser}@example.invalid` });
    const res = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: { authorization: `Bearer ${otherToken}`, 'idempotency-key': 'cross-tenant-key-1234' },
    });
    expect(res.status).toBe(404);
    await prisma.user.delete({ where: { id: otherUser } });
  });

  it('revokes an active gmail connection', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}`, {
      method: 'DELETE', headers,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { status: string; revokedAt: string } };
    expect(body).toMatchObject({ success: true });
    expect(body.data.status).toBe('REVOKED');
    expect(body.data.revokedAt).toBeDefined();
    await expect(prisma.emailConnection.findUniqueOrThrow({ where: { id: gmailConnectionId } })).resolves.toMatchObject({ status: 'REVOKED' });
  });

  it('prevents sync on a revoked connection', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/${gmailConnectionId}/sync`, {
      method: 'POST', headers: { ...headers, 'idempotency-key': 'revoked-sync-key-12345' },
    });
    expect(res.status).toBe(404);
  });
});

describeDatabase.sequential('public OAuth callback boundary', () => {
  const app = createApp();
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('OAuth callback fixture server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await prisma.$disconnect();
  });

  it('rejects a callback with missing state and code parameters without contacting providers', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/oauth/callback`);
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body).toMatchObject({ success: false, error: 'OAuth callback failed' });
  });

  it('fails closed on an unknown or expired OAuth state', async () => {
    const res = await fetch(`${baseUrl}/api/email-connections/oauth/callback?state=unknown-state&code=auth-code`);
    expect(res.status).toBe(400);
    const body = await res.json() as { success: boolean; error: string };
    expect(body).toMatchObject({ success: false, error: 'OAuth callback failed' });
  });
});
