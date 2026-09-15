import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEmailOutcome, authorizeSubmission, cancelAutomationJob, createSearchProfile, decideResumeFact, deleteSearchProfile, fetchApplication, fetchApplicationFunnel, fetchAutomationMetrics, fetchEmailConnections, fetchNotifications, fetchResumeFacts, fetchResumes, fetchSearchProfiles, markAllNotificationsRead, markNotificationRead, recordInterview, recordOffer, revokeEmailConnection, scheduleApplicationRun, setSearchProfileActive, streamAutomationEvents } from './api';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const sessionStorage = new MemoryStorage();
const localStorage = new MemoryStorage();

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem('jobagent.accessToken', 'test-token');
  vi.stubGlobal('window', { sessionStorage, localStorage });
  vi.restoreAllMocks();
});

describe('notification API integration', () => {
  it('resumes the authenticated SSE stream from a bounded event cursor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('id: event-7\ndata: {"type":"APPLICATION_CONFIRMED","message":"done"}\n\n', {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    await streamAutomationEvents((event) => events.push(event), new AbortController().signal, ' event-6 ');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('Last-Event-ID')).toBe('event-6');
    expect(events).toEqual([{ id: 'event-7', type: 'APPLICATION_CONFIRMED', message: 'done', timestamp: expect.any(String) }]);
  });

  it('does not propagate oversized SSE cursor values', async () => {
    const longId = 'x'.repeat(201);
    const fetchMock = vi.fn().mockResolvedValue(new Response(`id: ${longId}\ndata: {"type":"connected"}\n\n`, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const events: unknown[] = [];
    await streamAutomationEvents((event) => events.push(event), new AbortController().signal, longId);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get('Last-Event-ID')).toBeNull();
    expect(events).toEqual([{ type: 'connected', timestamp: expect.any(String) }]);
  });

  it('loads durable and queue automation metrics without collapsing unavailable queues to zero', async () => {
    const metrics = { queueMetrics: null, retryMetrics: { jobCount: 2, totalAttempts: 3, jobsWithRetries: 1 }, executionDuration: { sampleCount: 1, averageMs: 120, maxMs: 120 }, browserSessionDuration: { sampleCount: 1, averageMs: 80, maxMs: 80 }, pendingVerification: { pendingCount: 1, oldestAgeMs: 60_000, averageAgeMs: 60_000, maxAgeMs: 60_000 } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: metrics }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchAutomationMetrics()).resolves.toEqual(metrics);
  });

  it('loads the persisted application lifecycle funnel', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: [{ date: '2026-09-14', total: 2, statuses: { READY: 1, INTERVIEW: 1 } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchApplicationFunnel(30)).resolves.toEqual([{ date: '2026-09-14', total: 2, statuses: { READY: 1, INTERVIEW: 1 } }]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/analytics/applications-funnel?days=30');
  });

  it('loads authenticated notifications from the production endpoint', async () => {
    const notifications = [{
      id: 'notification-1',
      type: 'APPLICATION_CONFIRMED',
      title: 'Application confirmed',
      message: 'Confirmation evidence was stored.',
      read: false,
      createdAt: '2026-09-09T00:00:00.000Z',
    }];
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: notifications,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchNotifications()).resolves.toEqual(notifications);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notifications');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('marks all notifications read through the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      message: 'All notifications marked as read',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(markAllNotificationsRead()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/notifications/mark-all-read');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  });

  it('marks one notification read through the owner-scoped backend endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'notification-1', read: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(markNotificationRead('notification-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/notifications/notification-1/read');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
  });
});

describe('candidate fact API integration', () => {
  it('maps pending fact counts from authenticated resume data', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: [{
        id: 'resume-1', name: 'Master', isMaster: true, createdAt: '2026-09-10T00:00:00.000Z',
        updatedAt: '2026-09-10T00:00:00.000Z', versions: [], _count: { sourceFacts: 4 },
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchResumes()).resolves.toEqual([
      expect.objectContaining({ id: 'resume-1', pendingFactCount: 4 }),
    ]);
  });

  it('loads exact citations and posts approval decisions', async () => {
    const citation = [{
      id: 'fact-1', factType: 'SKILL', value: { text: 'TypeScript' }, sourceText: 'TypeScript',
      sourceStart: 20, sourceEnd: 30, approved: false,
    }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: citation }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { ...citation[0], approved: true } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchResumeFacts('resume/1')).resolves.toEqual(citation);
    await expect(decideResumeFact('resume/1', 'fact/1', 'APPROVE')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/resumes/resume%2F1/facts');
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ decision: 'APPROVE' }) });
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
  });
});

describe('application lifecycle API integration', () => {
  it('reads durable email consent state and revokes by connection identity', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ id: 'connection-1', provider: 'GMAIL', accountLabel: 'candidate@example.test', scopes: ['readonly'], status: 'ACTIVE' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'connection-1', status: 'REVOKED', revokedAt: '2026-09-15T00:00:00.000Z' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchEmailConnections()).resolves.toMatchObject([{ id: 'connection-1', status: 'ACTIVE' }]);
    await expect(revokeEmailConnection('connection/1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/email-connections');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/email-connections/connection%2F1');
    expect((fetchMock.mock.calls[1][1] as RequestInit).method).toBe('DELETE');
  });

  it('preserves persisted interviews and offers in application details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      id: 'app-1', jobId: 'job-1', status: 'INTERVIEW', createdAt: '2026-09-14T00:00:00.000Z', retryCount: 0,
      job: { company: 'Example', title: 'Engineer' }, interviews: [{ id: 'int-1', type: 'TECHNICAL', company: 'Example', role: 'Engineer', round: 1 }],
      offers: [{ id: 'offer-1', company: 'Example', role: 'Engineer', status: 'PENDING' }], attempts: [],
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    await expect(fetchApplication('app-1')).resolves.toMatchObject({ interviews: [{ id: 'int-1' }], offers: [{ id: 'offer-1' }] });
  });

  it('applies a reviewed email outcome with optimistic version and idempotency headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      application: { id: 'app-1', jobId: 'job-1', version: 4, status: 'REJECTED', createdAt: '2026-09-14T00:00:00.000Z', retryCount: 0, job: { company: 'Example', title: 'Engineer' }, attempts: [], interviews: [], offers: [], emailOutcomes: [],
    } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(applyEmailOutcome('outcome-1', 4, 'dashboard-review-1')).resolves.toMatchObject({ id: 'app-1', status: 'REJECTED', version: 4 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/email-outcomes/outcome-1/apply');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 4, correlationId: 'dashboard-review-1' });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('records lifecycle interview and offer events through idempotent endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'int-1', type: 'TECHNICAL', company: 'Example', role: 'Engineer', round: 1 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'offer-1', company: 'Example', role: 'Engineer', status: 'PENDING' } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(recordInterview('app-1', { type: 'TECHNICAL', company: 'Example', role: 'Engineer' })).resolves.toMatchObject({ id: 'int-1' });
    await expect(recordOffer('app-1', { company: 'Example', role: 'Engineer' })).resolves.toMatchObject({ id: 'offer-1' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/applications/app-1/interviews');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/applications/app-1/offers');
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('requires the current application version when authorizing submission', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { authorizationId: 'auth-1', automationJobId: 'job-1', status: 'SUBMISSION_PENDING' } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(authorizeSubmission('app-1', 7, 'dashboard-submission:app-1')).resolves.toMatchObject({ authorizationId: 'auth-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/applications/app-1/authorize-submission');
    expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: 7, correlationId: 'dashboard-submission:app-1' });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('schedules an application run through the durable backend endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'job-1', status: 'AVAILABLE', availableAt: '2026-09-16T10:00:00.000Z' } }), { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(scheduleApplicationRun('app-1', '2026-09-16T10:00:00.000Z', 'run-1')).resolves.toMatchObject({ id: 'job-1' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/applications/app-1/schedule');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ runAt: '2026-09-16T10:00:00.000Z', correlationId: 'dashboard-schedule:app-1', automationRunId: 'run-1' });
    expect(new Headers(init.headers).get('Idempotency-Key')).toBeTruthy();
  });

  it('cancels a persisted automation job through the owner-scoped endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'job-1', status: 'CANCELLED' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(cancelAutomationJob('job-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/automation/jobs/job-1/cancel');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('loads and toggles durable search-profile schedules', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: [{ id: 'profile-1', name: 'Platform roles', schedule: 'DAILY', isActive: true }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'profile-1', name: 'Platform roles', schedule: 'DAILY', isActive: false } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSearchProfiles()).resolves.toMatchObject([{ id: 'profile-1', isActive: true }]);
    await expect(setSearchProfileActive('profile-1', false)).resolves.toMatchObject({ id: 'profile-1', isActive: false });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/search-profiles/profile-1');
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({ isActive: false });
  });

  it('cancels a durable search-profile schedule through the backend', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, message: 'Deleted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(deleteSearchProfile('profile-1')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search-profiles/profile-1');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('creates a provider-backed durable search profile', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'profile-2', name: 'Lever roles', schedule: 'DAILY', isActive: true } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSearchProfile({ name: 'Lever roles', targetRoles: ['Engineer'], cities: ['Remote'], schedule: 'DAILY', discoveryAccounts: [{ source: 'LEVER', account: 'example' }] })).resolves.toMatchObject({ id: 'profile-2' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/search-profiles');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ schedule: 'DAILY', discoveryAccounts: [{ source: 'LEVER', account: 'example' }] });
  });

  it('passes custom cron schedules through the profile client', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, data: { id: 'profile-cron', name: 'Weekday roles', schedule: 'CUSTOM', isActive: true } }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createSearchProfile({ name: 'Weekday roles', targetRoles: ['Engineer'], cities: [], schedule: 'CUSTOM', customCron: '30 9 * * 1-5', maxApplicationsPerDay: 12, discoveryAccounts: [{ source: 'GREENHOUSE', account: 'example' }] })).resolves.toMatchObject({ id: 'profile-cron' });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ schedule: 'CUSTOM', customCron: '30 9 * * 1-5', maxApplicationsPerDay: 12 });
  });
});
