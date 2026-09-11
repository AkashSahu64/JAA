import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BrowserNavigationPolicy, BrowserNavigationPolicyError, classifyBlockedIpLiteral } from '@jobagent/security';
import { withTenant } from '@jobagent/database';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const activeStatus = 'ACTIVE';
const closedStatus = 'CLOSED';
const expiredStatus = 'EXPIRED';
const maxSessionLifetimeMs = 60 * 60 * 1000;

type LiveSession = {
  context: BrowserContext;
  page: Page;
  policy: BrowserNavigationPolicy;
  userId: string;
  correlationId: string;
  expiresAt: Date;
};

type SessionCloseReason = 'STARTUP_FAILED' | 'SHUTDOWN';

export class BrowserSessionError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'EXPIRED' | 'POLICY_DENIED', message: string) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

export interface StartBrowserSessionInput {
  userId: string;
  applicationId?: string;
  targetUrl: string;
  allowedHosts: readonly string[];
  workerId: string;
  correlationId: string;
  idempotencyKey: string;
  expiresAt: Date;
}

function requireText(value: string, name: string): void {
  if (!value.trim()) throw new BrowserSessionError('INVALID', `${name} is required`);
}

function validExpiry(expiresAt: Date, now: Date): boolean {
  return Number.isFinite(expiresAt.getTime()) && expiresAt > now
    && expiresAt.getTime() - now.getTime() <= maxSessionLifetimeMs;
}

function policyFor(allowedHosts: readonly string[]): BrowserNavigationPolicy {
  if (!allowedHosts.length) throw new BrowserSessionError('INVALID', 'At least one allowed host is required');
  try {
    return new BrowserNavigationPolicy({ allowedHosts });
  } catch (error) {
    throw new BrowserSessionError('INVALID', error instanceof Error ? error.message : 'Allowed hosts are invalid');
  }
}

function assertAllowed(policy: BrowserNavigationPolicy, target: string): URL {
  try {
    return policy.assertAllowed(target);
  } catch (error) {
    if (error instanceof BrowserNavigationPolicyError) {
      throw new BrowserSessionError('POLICY_DENIED', error.message);
    }
    throw error;
  }
}

type ResolveBrowserHost = (hostname: string) => Promise<readonly string[]>;

async function resolveBrowserHost(hostname: string): Promise<readonly string[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(address => address.address);
}

async function assertDnsSafe(target: URL, resolveHost: ResolveBrowserHost): Promise<void> {
  let addresses: readonly string[];
  try {
    addresses = await resolveHost(target.hostname);
  } catch {
    throw new BrowserSessionError(
      'POLICY_DENIED',
      'Browser navigation hostname could not be resolved safely',
    );
  }
  if (!addresses.length || addresses.some(address => classifyBlockedIpLiteral(address))) {
    throw new BrowserSessionError('POLICY_DENIED', 'Browser navigation resolved to a blocked network address');
  }
}

export class BrowserSessionManager {
  private browser: Browser | undefined;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(
    private readonly launchBrowser: () => Promise<Browser> = () => chromium.launch({ headless: true }),
    private readonly resolveHost: ResolveBrowserHost = resolveBrowserHost,
  ) {}

  async start(input: StartBrowserSessionInput) {
    requireText(input.userId, 'userId');
    requireText(input.targetUrl, 'targetUrl');
    requireText(input.workerId, 'workerId');
    requireText(input.correlationId, 'correlationId');
    requireText(input.idempotencyKey, 'idempotencyKey');
    const now = new Date();
    if (!validExpiry(input.expiresAt, now)) throw new BrowserSessionError('INVALID', 'Session expiry must be within the next hour');
    const policy = policyFor(input.allowedHosts);
    const target = assertAllowed(policy, input.targetUrl);
    await assertDnsSafe(target, this.resolveHost);
    const externalRef = `browser-session:${randomUUID()}`;

    const persisted = await withTenant(input.userId, async tx => {
      const existing = await tx.browserSessionReference.findFirst({ where: { userId: input.userId, idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (existing.applicationId !== (input.applicationId ?? null) || existing.allowedHost !== target.hostname || existing.initialUrl !== target.href || existing.correlationId !== input.correlationId) {
          throw new BrowserSessionError('INVALID', 'Idempotency key was already used for a different browser session');
        }
        return { session: existing, replayed: true as const };
      }
      if (input.applicationId) {
        const application = await tx.application.findFirst({ where: { id: input.applicationId, userId: input.userId }, select: { id: true } });
        if (!application) throw new BrowserSessionError('NOT_FOUND', 'Application not found');
      }
      const session = await tx.browserSessionReference.create({ data: {
        userId: input.userId, applicationId: input.applicationId, workerId: input.workerId, externalRef,
        status: activeStatus, allowedHost: target.hostname, initialUrl: target.href, correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey, expiresAt: input.expiresAt,
      } });
      await Promise.all([
        tx.auditLog.create({ data: { userId: input.userId, action: 'BROWSER_SESSION_STARTED', resource: 'BrowserSessionReference', resourceId: session.id, details: { applicationId: input.applicationId, allowedHost: target.hostname } } }),
        tx.outboxEvent.create({ data: { userId: input.userId, aggregateType: 'BrowserSessionReference', aggregateId: session.id, eventType: 'browser-session.started', payload: { applicationId: input.applicationId, allowedHost: target.hostname, expiresAt: input.expiresAt.toISOString() }, schemaVersion: 1, correlationId: input.correlationId, idempotencyKey: `browser-session-started:${session.id}` } }),
      ]);
      return { session, replayed: false as const };
    });
    if (persisted.replayed && this.sessions.has(persisted.session.externalRef)) return persisted;

    try {
      const browser = this.browser ?? await this.launchBrowser();
      this.browser = browser;
      const context = await browser.newContext({ acceptDownloads: false, permissions: [] });
      const page = await context.newPage();
      await this.installNavigationGuard(page, policy);
      this.sessions.set(persisted.session.externalRef, {
        context, page, policy, userId: input.userId, correlationId: input.correlationId, expiresAt: input.expiresAt,
      });
      await page.goto(target.href, {
        waitUntil: 'domcontentloaded',
        timeout: this.navigationTimeout(input.expiresAt),
      });
      return persisted;
    } catch (error) {
      await this.close(
        input.userId,
        persisted.session.externalRef,
        input.correlationId,
        closedStatus,
        'STARTUP_FAILED',
      );
      throw error;
    }
  }

  async navigate(externalRef: string, targetUrl: string): Promise<void> {
    const session = this.sessions.get(externalRef);
    if (!session) throw new BrowserSessionError('NOT_FOUND', 'Live browser session not found');
    if (session.expiresAt <= new Date()) {
      await this.close(session.userId, externalRef, session.correlationId, expiredStatus);
      throw new BrowserSessionError('EXPIRED', 'Browser session has expired');
    }
    const target = assertAllowed(session.policy, targetUrl);
    await assertDnsSafe(target, this.resolveHost);
    await session.page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeout(session.expiresAt),
    });
  }

  async withPage<T>(
    userId: string,
    externalRef: string,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    const session = this.sessions.get(externalRef);
    if (!session || session.userId !== userId) {
      throw new BrowserSessionError('NOT_FOUND', 'Live browser session not found');
    }
    if (session.expiresAt <= new Date()) {
      await this.close(userId, externalRef, session.correlationId, expiredStatus);
      throw new BrowserSessionError('EXPIRED', 'Browser session has expired');
    }
    return operation(session.page);
  }

  async close(
    userId: string,
    externalRef: string,
    correlationId: string,
    status = closedStatus,
    reason?: SessionCloseReason,
  ): Promise<void> {
    const live = this.sessions.get(externalRef);
    this.sessions.delete(externalRef);
    await live?.context.close();
    await withTenant(userId, async tx => {
      const updated = await tx.browserSessionReference.updateMany({
        where: { userId, externalRef, status: activeStatus },
        data: { status, closedAt: new Date() },
      });
      if (!updated.count) return;
      await Promise.all([
        tx.auditLog.create({
          data: {
            userId,
            action: 'BROWSER_SESSION_CLOSED',
            resource: 'BrowserSessionReference',
            resourceId: externalRef,
            details: { status, ...(reason ? { reason } : {}) },
          },
        }),
        tx.outboxEvent.create({
          data: {
            userId,
            aggregateType: 'BrowserSessionReference',
            aggregateId: externalRef,
            eventType: 'browser-session.closed',
            payload: { status, ...(reason ? { reason } : {}) },
            schemaVersion: 1,
            correlationId,
            idempotencyKey: `browser-session-closed:${externalRef}`,
          },
        }),
      ]);
    });
  }

  async shutdown(): Promise<void> {
    const sessions = [...this.sessions.entries()];
    await Promise.all(sessions.map(async ([externalRef, session]) => {
      await this.close(
        session.userId,
        externalRef,
        session.correlationId,
        closedStatus,
        'SHUTDOWN',
      );
    }));
    const browser = this.browser;
    this.browser = undefined;
    await browser?.close();
  }

  private navigationTimeout(expiresAt: Date): number {
    return Math.max(1, Math.min(30_000, expiresAt.getTime() - Date.now()));
  }

  private async installNavigationGuard(page: Page, policy: BrowserNavigationPolicy): Promise<void> {
    await page.route('**/*', async route => {
      const request = route.request();
      const decision = policy.evaluate(request.url());
      if (!decision.allowed) return route.abort('blockedbyclient');

      // Every browser-originated request, including redirects and subresources, is
      // re-authorized and re-resolved. This prevents a hostile page from using an
      // allowlisted hostname that resolves to a private address after startup.
      try {
        await assertDnsSafe(new URL(decision.normalizedUrl!), this.resolveHost);
      } catch {
        return route.abort('blockedbyclient');
      }
      return route.continue();
    });
  }
}
