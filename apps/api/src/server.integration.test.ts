import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

const enabled = process.env.DATABASE_INTEGRATION === '1' && Boolean(process.env.DATABASE_URL);
const describeDatabase = enabled ? describe : describe.skip;

describeDatabase.sequential('live HTTP readiness', () => {
  const app = createApp();
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  beforeAll(async () => {
    server = app.listen(0);
    await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('separates liveness from authoritative database readiness', async () => {
    const traceparent = '00-abcdef0123456789abcdef0123456789-abcdef0123456789-01';
    const health = await fetch(`${baseUrl}/api/health`, { headers: { traceparent } });
    expect(health.status).toBe(200);
    expect(health.headers.get('traceparent')).toBe(traceparent);
    expect(health.headers.get('x-correlation-id')).toMatch(/^[0-9a-f-]{36}$/);
    expect(await health.json()).toMatchObject({ status: 'ok' });
    const ready = await fetch(`${baseUrl}/api/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', checks: { database: 'ok' } });
  });
});
