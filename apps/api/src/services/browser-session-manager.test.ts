import { describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => {
  const references = new Map<string, Record<string, unknown>>();
  let nextId = 0;
  return {
    references,
    reset() {
      references.clear();
      nextId = 0;
    },
    tx: {
      browserSessionReference: {
        findFirst: vi.fn(async ({ where }) => references.get(where.idempotencyKey) ?? null),
        create: vi.fn(async ({ data }) => {
          const session = { id: `session-${++nextId}`, ...data };
          references.set(data.idempotencyKey, session);
          return session;
        }),
        updateMany: vi.fn(async ({ where, data }) => {
          const session = [...references.values()].find(candidate =>
            candidate.userId === where.userId
            && candidate.externalRef === where.externalRef
            && candidate.status === where.status,
          );
          if (!session) return { count: 0 };
          Object.assign(session, data);
          return { count: 1 };
        }),
      },
      application: { findFirst: vi.fn(async () => ({ id: 'application-1' })) },
      auditLog: { create: vi.fn(async () => ({})) },
      outboxEvent: { create: vi.fn(async () => ({})) },
    },
  };
});

vi.mock('@jobagent/database', () => ({
  withTenant: async (_userId: string, operation: (tx: typeof database.tx) => unknown) => operation(database.tx),
}));

import { BrowserSessionError, BrowserSessionManager } from './browser-session-manager';

type FakePage = {
  goto: ReturnType<typeof vi.fn>;
  route: ReturnType<typeof vi.fn>;
  mainFrame: ReturnType<typeof vi.fn>;
};

function fakeBrowser() {
  const page: FakePage = {
    goto: vi.fn(async () => undefined),
    route: vi.fn(async () => undefined),
    mainFrame: vi.fn(() => ({})),
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

function input(overrides: Partial<Parameters<BrowserSessionManager['start']>[0]> = {}) {
  return {
    userId: 'user-1',
    applicationId: 'application-1',
    targetUrl: 'https://careers.example.com/apply',
    allowedHosts: ['careers.example.com'],
    workerId: 'worker-1',
    correlationId: 'correlation-1',
    idempotencyKey: 'session-1',
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('BrowserSessionManager', () => {
  it('creates an isolated context and blocks private DNS results before launch', async () => {
    database.reset();
    const fake = fakeBrowser();
    const launch = vi.fn(async () => fake.browser as never);
    const manager = new BrowserSessionManager(launch, async () => ['127.0.0.1']);

    await expect(manager.start(input())).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    } satisfies Partial<BrowserSessionError>);
    expect(launch).not.toHaveBeenCalled();

    const safeManager = new BrowserSessionManager(launch, async () => ['93.184.216.34']);
    await safeManager.start(input({ idempotencyKey: 'session-2' }));
    expect(fake.browser.newContext).toHaveBeenCalledWith({
      acceptDownloads: false,
      permissions: [],
    });
  });

  it('denies browser-originated requests whose host resolves privately', async () => {
    database.reset();
    const fake = fakeBrowser();
    const manager = new BrowserSessionManager(
      async () => fake.browser as never,
      async (hostname: string) => hostname === 'internal.example.com'
        ? ['192.168.1.1']
        : ['93.184.216.34'],
    );
    await manager.start(input({ allowedHosts: ['careers.example.com', 'internal.example.com'] }));

    const routeHandler = fake.page.route.mock.calls[0][1] as (route: {
      request: () => { url: () => string };
      abort: ReturnType<typeof vi.fn>;
      continue: ReturnType<typeof vi.fn>;
    }) => Promise<void>;
    const route = {
      request: () => ({ url: () => 'https://internal.example.com/redirect-target' }),
      abort: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
    };

    await routeHandler(route);
    expect(route.abort).toHaveBeenCalledWith('blockedbyclient');
    expect(route.continue).not.toHaveBeenCalled();
  });

  it('fails closed on malformed runtime session inputs', async () => {
    const fake = fakeBrowser();
    const manager = new BrowserSessionManager(async () => fake.browser as never, async () => ['93.184.216.34']);
    await expect(manager.start(input({ targetUrl: 123 as never }))).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<BrowserSessionError>);
    await expect(manager.start(input({ expiresAt: 'tomorrow' as never }))).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<BrowserSessionError>);
    await expect(manager.start(input({ allowedHosts: 'careers.example.com' as never }))).rejects.toMatchObject({ code: 'INVALID' } satisfies Partial<BrowserSessionError>);
    expect(fake.browser.newContext).not.toHaveBeenCalled();
  });


  it('revalidates DNS before explicit navigation and closes startup failures', async () => {
    database.reset();
    const fake = fakeBrowser();
    const resolver = vi.fn(async (hostname: string) => hostname === 'blocked.example.com'
      ? ['10.0.0.1']
      : ['93.184.216.34']);
    const manager = new BrowserSessionManager(async () => fake.browser as never, resolver);
    const started = await manager.start(input({
      allowedHosts: ['careers.example.com', 'blocked.example.com'],
    }));

    await expect(manager.navigate(
      (started.session as { externalRef: string }).externalRef,
      'https://blocked.example.com/apply',
    )).rejects.toMatchObject({ code: 'POLICY_DENIED' } satisfies Partial<BrowserSessionError>);
    expect(fake.page.goto).toHaveBeenCalledTimes(1);

    const failing = fakeBrowser();
    failing.page.goto.mockRejectedValueOnce(new Error('navigation failed'));
    const failingManager = new BrowserSessionManager(async () => failing.browser as never, async () => ['93.184.216.34']);
    await expect(failingManager.start(input({ idempotencyKey: 'session-3' }))).rejects.toThrow('navigation failed');
    expect(database.references.get('session-3')).toMatchObject({ status: 'CLOSED' });
    expect(failing.context.close).toHaveBeenCalledOnce();
  });
});
