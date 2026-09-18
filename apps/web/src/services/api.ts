import {
  ApplicationAttempt,
  AuthUser,
  AutomationEvent,
  AutomationRun,
  DashboardStats,
  ApplicationFunnelRow,
  DiscoveryRequest,
  DiscoveryRunStatus,
  DiscoveryRunSummary,
  UIApplication,
  UIJob,
  UIResume,
  UIResumeVersion,
  UICandidateFact,
  UIInterview,
  OfferRecord,
  UIEmailOutcome,
  UIEmailConnection,
  UISearchProfile,
} from '../types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
const TOKEN_KEY = 'jobagent.accessToken';
const REFRESH_TOKEN_KEY = 'jobagent.refreshToken';
const USER_KEY = 'jobagent.user';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  errors?: string[];
}

interface PaginatedEnvelope<T> extends ApiEnvelope<T[]> {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface AuthPayload {
  user: AuthUser;
  token: string;
  refreshToken: string;
}

export interface AuthSession {
  user: AuthUser;
  token: string;
}

export class ApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

function getStoredUser(): AuthUser | null {
  const raw = window.sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

function storeSession(payload: AuthPayload): AuthSession {
  window.sessionStorage.setItem(TOKEN_KEY, payload.token);
  window.sessionStorage.setItem(REFRESH_TOKEN_KEY, payload.refreshToken);
  window.sessionStorage.setItem(USER_KEY, JSON.stringify(payload.user));
  return { user: payload.user, token: payload.token };
}

export function clearSession(): void {
  window.sessionStorage.removeItem(TOKEN_KEY);
  window.sessionStorage.removeItem(REFRESH_TOKEN_KEY);
  window.sessionStorage.removeItem(USER_KEY);
  window.localStorage.removeItem(TOKEN_KEY);
}

export function getAccessToken(): string | null {
  return window.sessionStorage.getItem(TOKEN_KEY);
}

export function hasApiToken(): boolean {
  return Boolean(getAccessToken());
}

export async function logout(): Promise<void> {
  const refreshToken = window.sessionStorage.getItem(REFRESH_TOKEN_KEY);
  try {
    if (refreshToken) await apiRequest<{ revoked: boolean }>('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
  } finally {
    clearSession();
  }
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = await response.json() as ApiEnvelope<T>;
  } catch {
    // Keep the HTTP status for non-JSON proxy/server errors.
  }
  if (!response.ok || !payload?.success || payload.data === undefined) {
    if (response.status === 401) clearSession();
    throw new ApiError(payload?.error || payload?.errors?.join(', ') || `Request failed (${response.status})`, response.status);
  }
  return payload.data;
}

async function authRequest(path: '/auth/login' | '/auth/register', body: Record<string, string>): Promise<AuthSession> {
  const payload = await apiRequest<AuthPayload>(path, { method: 'POST', body: JSON.stringify(body) });
  return storeSession(payload);
}

export function login(email: string, password: string): Promise<AuthSession> {
  return authRequest('/auth/login', { email, password });
}

export function register(name: string, email: string, password: string): Promise<AuthSession> {
  return authRequest('/auth/register', { name, email, password });
}

export async function restoreSession(): Promise<AuthSession | null> {
  const token = getAccessToken();
  if (!token) return null;
  const stored = getStoredUser();
  try {
    const user = await apiRequest<AuthUser>('/auth/me');
    window.sessionStorage.setItem(USER_KEY, JSON.stringify(user));
    return { token, user: stored?.id === user.id ? { ...stored, ...user } : user };
  } catch {
    clearSession();
    return null;
  }
}

export async function fetchJobs(search = '', signal?: AbortSignal): Promise<UIJob[]> {
  const params = new URLSearchParams({ page: '0', pageSize: '100' });
  if (search.trim()) params.set('search', search.trim());
  const response = await apiEnvelopeRequest<PaginatedEnvelope<RawJob>>(`/jobs?${params}`, { signal });
  return response.data!.map(toUIJob);
}

export async function discoverJobs(input: DiscoveryRequest, signal?: AbortSignal): Promise<{ runs: DiscoveryRunSummary[] }> {
  const requestKey = crypto.randomUUID();
  const request = () => apiRequest<{ runs: RawDiscoveryRun[] }>('/jobs/discover', {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'Idempotency-Key': requestKey },
    signal,
  });
  let result: { runs: RawDiscoveryRun[] };
  try {
    result = await request();
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    result = await request();
  }
  return { runs: result.runs.map(toDiscoveryRunSummary) };
}

export async function fetchDiscoveryRuns(limit = 20, signal?: AbortSignal): Promise<DiscoveryRunSummary[]> {
  const runs = await apiRequest<RawDiscoveryRun[]>(`/jobs/discovery-runs?limit=${Math.max(1, Math.min(100, Math.floor(limit)))}`, { signal });
  return runs.map(toDiscoveryRunSummary);
}

export async function fetchApplications(status?: string): Promise<UIApplication[]> {
  const params = new URLSearchParams({ page: '0', pageSize: '100' });
  if (status) params.set('status', status);
  const response = await apiEnvelopeRequest<PaginatedEnvelope<RawApplication>>(`/applications?${params}`);
  return response.data!.map(toUIApplication);
}

export async function fetchApplication(id: string): Promise<UIApplication> {
  const app = await apiRequest<RawApplicationDetail>(`/applications/${encodeURIComponent(id)}`);
  return { ...toUIApplication(app), attempts: app.attempts?.map(toAttempt) ?? [], interviews: app.interviews ?? [], offers: app.offers ?? [], emailOutcomes: app.emailOutcomes ?? [], jobs: app.jobs ?? [] };
}

export async function fetchResumes(): Promise<UIResume[]> {
  const resumes = await apiRequest<RawResume[]>('/resumes');
  return resumes.map((resume) => ({
    ...resume,
    pendingFactCount: resume._count?.sourceFacts ?? 0,
    versions: resume.versions.map((version) => toResumeVersion(resume, version)),
  }));
}

export async function uploadResume(file: File): Promise<void> {
  const form = new FormData();
  form.append('resume', file);
  form.append('name', file.name.replace(/\.[^.]+$/, ''));
  form.append('isMaster', 'true');
  await apiRequest('/resumes/upload', { method: 'POST', body: form });
}

export function fetchResumeFacts(resumeId: string): Promise<UICandidateFact[]> {
  return apiRequest<UICandidateFact[]>(`/resumes/${encodeURIComponent(resumeId)}/facts`);
}

export async function decideResumeFact(resumeId: string, factId: string, decision: 'APPROVE' | 'REJECT'): Promise<void> {
  await apiRequest(`/resumes/${encodeURIComponent(resumeId)}/facts/${encodeURIComponent(factId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}

export function decideOffer(applicationId: string, offerId: string, decision: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN' | 'EXPIRED'): Promise<OfferRecord> {
  return apiRequest<OfferRecord>(`/applications/${encodeURIComponent(applicationId)}/offers/${encodeURIComponent(offerId)}/decision`, {
    method: 'PATCH',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ decision }),
  });
}

export async function applyEmailOutcome(outcomeId: string, expectedVersion: number, correlationId: string): Promise<UIApplication> {
  const result = await apiRequest<{ application: RawApplicationDetail }>(`/email-outcomes/${encodeURIComponent(outcomeId)}/apply`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ expectedVersion, correlationId }),
  });
  const application = result.application;
  return { ...toUIApplication(application), attempts: application.attempts?.map(toAttempt) ?? [], interviews: application.interviews ?? [], offers: application.offers ?? [], emailOutcomes: application.emailOutcomes ?? [] };
}

export async function reviewEmailOutcome(outcomeId: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/email-outcomes/${encodeURIComponent(outcomeId)}/review`, { method: 'POST' }, false);
}

export function fetchEmailConnections(): Promise<UIEmailConnection[]> {
  return apiRequest<UIEmailConnection[]>('/email-connections');
}

export function startEmailOAuth(provider: 'GMAIL' | 'MICROSOFT_GRAPH', accountLabel: string, scopes: string[], redirectUri: string): Promise<{ authorizationUrl: string; stateId: string; expiresAt: string }> {
  return apiRequest<{ authorizationUrl: string; stateId: string; expiresAt: string }>('/email-connections/oauth/start', {
    method: 'POST',
    body: JSON.stringify({ provider, accountLabel, scopes, redirectUri }),
  });
}

export function syncEmailConnection(connectionId: string): Promise<{ id: string; status: string; replayed: boolean }> {
  return apiRequest<{ id: string; status: string; replayed: boolean }>(`/email-connections/${encodeURIComponent(connectionId)}/sync`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
  });
}

export async function revokeEmailConnection(connectionId: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/email-connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }, false);
}

export function recordInterview(applicationId: string, input: Pick<UIInterview, 'type' | 'company' | 'role'> & { date?: string }): Promise<UIInterview> {
  return apiRequest<UIInterview>(`/applications/${encodeURIComponent(applicationId)}/interviews`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function recordOffer(applicationId: string, input: Pick<OfferRecord, 'company' | 'role'> & { salaryOffered?: number; currency?: string; startDate?: string; expiresAt?: string; benefits?: string }): Promise<OfferRecord> {
  return apiRequest<OfferRecord>(`/applications/${encodeURIComponent(applicationId)}/offers`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify(input),
  });
}

export function authorizeSubmission(applicationId: string, expectedVersion: number, correlationId: string): Promise<{ authorizationId: string; automationJobId: string; status: string; replayed?: boolean }> {
  return apiRequest(`/applications/${encodeURIComponent(applicationId)}/authorize-submission`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ expectedVersion, correlationId }),
  });
}

export function markApplicationReadyForSubmission(applicationId: string, expectedVersion: number): Promise<UIApplication> {
  return apiRequest<UIApplication>(`/applications/${encodeURIComponent(applicationId)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: 'READY_TO_SUBMIT', expectedVersion,
      reason: 'User reviewed the completed provider form and marked it ready for explicit submission authorization',
      idempotencyKey: `dashboard-ready-to-submit:${applicationId}:${expectedVersion}`,
      correlationId: `dashboard-ready-to-submit:${applicationId}`,
      metadata: { reviewedByUser: true },
    }),
  });
}

export function scheduleApplicationRun(applicationId: string, runAt: string, automationRunId?: string): Promise<{ id: string; status: string; availableAt: string; replayed?: boolean }> {
  return apiRequest(`/applications/${encodeURIComponent(applicationId)}/schedule`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ runAt, correlationId: `dashboard-schedule:${applicationId}`, ...(automationRunId ? { automationRunId } : {}) }),
  });
}

export async function cancelAutomationJob(jobId: string): Promise<void> {
  await apiRequest(`/automation/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
}

export async function chatWithAssistant(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<string> {
  const result = await apiRequest<{ reply: string }>('/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ messages }),
  });
  return result.reply;
}

export function fetchStats(): Promise<DashboardStats> {
  return apiRequest<DashboardStats>('/analytics/dashboard');
}

export function fetchApplicationTimeline(days = 30): Promise<Array<{ date: string; count: number }>> {
  return apiRequest<Array<{ date: string; count: number }>>(`/analytics/applications-over-time?days=${days}`);
}

export function fetchApplicationFunnel(days = 30): Promise<ApplicationFunnelRow[]> {
  return apiRequest<ApplicationFunnelRow[]>(`/analytics/applications-funnel?days=${days}`);
}

export function fetchRules(): Promise<UIRule[]> {
  return apiRequest<UIRule[]>('/rules');
}

export function fetchSearchProfiles(): Promise<UISearchProfile[]> {
  return apiRequest<UISearchProfile[]>('/search-profiles');
}

export function createSearchProfile(input: { name: string; targetRoles: string[]; cities: string[]; schedule: string; customCron?: string; timeZone?: string; maxApplicationsPerDay?: number; discoveryAccounts: Array<{ source: 'GREENHOUSE' | 'LEVER' | 'ASHBY'; account: string }> }): Promise<UISearchProfile> {
  return apiRequest<UISearchProfile>('/search-profiles', { method: 'POST', body: JSON.stringify(input) });
}

export function setSearchProfileActive(id: string, isActive: boolean): Promise<UISearchProfile> {
  return apiRequest<UISearchProfile>(`/search-profiles/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ isActive }) });
}

export async function deleteSearchProfile(id: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/search-profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }, false);
}

export function createRule(rule: Pick<UIRule, 'name' | 'conditions' | 'action' | 'priority'>): Promise<UIRule> {
  return apiRequest<UIRule>('/rules', { method: 'POST', body: JSON.stringify(rule) });
}

export async function deleteRule(id: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }, false);
}

export interface UIRule {
  id: string;
  name: string;
  conditions: unknown[];
  action: 'REVIEW' | 'APPLY' | 'SKIP' | 'NOTIFY';
  priority: number;
  enabled: boolean;
}

export interface UINotification {
  id: string;
  type: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: string;
  data?: { verificationId?: string; applicationId?: string; [key: string]: unknown };
}

export interface UIHumanVerification {
  id: string;
  applicationId: string;
  type: string;
  status: string;
  prompt: string;
  context?: unknown;
  expiresAt: string;
  resolvedAt?: string;
  createdAt: string;
}

export function fetchNotifications(): Promise<UINotification[]> {
  return apiRequest<UINotification[]>('/notifications');
}

export interface UINotificationPage {
  notifications: UINotification[];
  nextCursor: string | null;
}

export async function fetchNotificationPage(before?: string): Promise<UINotificationPage> {
  const query = before ? `?before=${encodeURIComponent(before)}` : '';
  const response = await apiEnvelopeRequest<ApiEnvelope<UINotification[]> & { nextCursor?: string | null }>(`/notifications${query}`);
  return { notifications: response.data ?? [], nextCursor: response.nextCursor ?? null };
}

export async function markNotificationRead(id: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'PATCH' }, false);
}

export async function markAllNotificationsRead(): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>('/notifications/mark-all-read', { method: 'POST' }, false);
}

export function fetchHumanVerifications(): Promise<UIHumanVerification[]> {
  return apiRequest<UIHumanVerification[]>('/human-verifications');
}

export async function resolveHumanVerification(id: string): Promise<void> {
  await apiEnvelopeRequest<ApiEnvelope<never>>(`/human-verifications/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({}) }, false);
}

export function fetchAutomationStatus(): Promise<AutomationRun | null> {
  return apiRequest<AutomationRun | null>('/automation/status');
}

export function fetchAutomationEvents(): Promise<AutomationEvent[]> {
  return apiRequest<AutomationEvent[]>('/automation/events?limit=100');
}

export interface AutomationQueueMetric {
  queue: string;
  waiting: number;
  oldestWaitingMs: number | null;
  active: number;
  delayed: number;
  prioritized: number;
  completed: number;
  failed: number;
  paused: number;
}

export interface AutomationMetrics {
  queueMetrics: AutomationQueueMetric[] | null;
  retryMetrics: { jobCount: number; totalAttempts: number; jobsWithRetries: number };
  executionDuration: { sampleCount: number; averageMs: number; maxMs: number };
  browserSessionDuration: { sampleCount: number; averageMs: number; maxMs: number };
  pendingVerification: { pendingCount: number; oldestAgeMs: number; averageAgeMs: number; maxAgeMs: number };
  alerts: Array<{ code: string; severity: 'WARNING' | 'CRITICAL'; message: string; value: number; threshold: number }>;
}

export function fetchAutomationMetrics(): Promise<AutomationMetrics> {
  return apiRequest<AutomationMetrics>('/automation/metrics');
}

export async function setAutomationState(running: boolean, currentlyPaused = false): Promise<AutomationRun> {
  const path = running ? (currentlyPaused ? '/automation/resume' : '/automation/start') : '/automation/pause';
  return apiRequest<AutomationRun>(path, {
    method: 'POST',
    ...(path === '/automation/start' ? { body: JSON.stringify({ mode: 'ASSISTED' }) } : {}),
  });
}

export async function streamAutomationEvents(
  onEvent: (event: AutomationEvent) => void,
  signal: AbortSignal,
  lastEventId?: string,
): Promise<void> {
  const token = getAccessToken();
  if (!token) throw new ApiError('Sign in to connect to live events.', 401);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' };
  if (typeof lastEventId === 'string' && lastEventId.trim() && lastEventId.length <= 200) headers['Last-Event-ID'] = lastEventId.trim();
  const response = await fetch(`${API_BASE}/sse/events`, {
    headers,
    signal,
  });
  if (!response.ok || !response.body) {
    if (response.status === 401) clearSession();
    throw new ApiError(`Live event connection failed (${response.status})`, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamDone = false;
  const safeEventType = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim())
    && value.length <= 200 && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  while (!streamDone) {
    const { value, done } = await reader.read();
    streamDone = done;
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const frameId = frame.split('\n').find((line) => line.startsWith('id:'))?.slice(3).trim();
      const frameType = frame.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = frame.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as Partial<AutomationEvent> & { type: string };
        const eventType = safeEventType(parsed.type)
          ? parsed.type.trim()
          : typeof frameType === 'string' && frameType.length <= 200 && !Array.from(frameType).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
            ? frameType : undefined;
        if (!eventType) continue;
        onEvent({
          ...parsed,
          ...(frameId && frameId.length <= 200 ? { id: frameId } : {}),
          type: eventType,
          timestamp: parsed.timestamp ?? new Date().toISOString(),
        });
      } catch {
        // Ignore malformed frames while keeping the authenticated stream alive.
      }
    }
  }
}

async function apiEnvelopeRequest<T extends ApiEnvelope<unknown>>(path: string, init: RequestInit = {}, requireData = true): Promise<T> {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const payload = await response.json() as T;
  if (!response.ok || !payload.success || (requireData && payload.data === undefined)) {
    if (response.status === 401) clearSession();
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status);
  }
  return payload;
}

interface RawDiscoveryRun {
  id: string;
  automationJobId?: string;
  status?: string;
  sources?: unknown;
  source?: string;
  sourceAccount?: string;
  query?: unknown;
  location?: unknown;
  discoveredCount?: number;
  normalizedCount?: number;
  duplicateCount?: number;
  savedCount?: number;
  failedCount?: number;
  itemsFetched?: number;
  itemsNormalized?: number;
  itemsDuplicate?: number;
  jobsCreated?: number;
  jobsUpdated?: number;
  itemsRejected?: number;
  errorCount?: number;
  errorClass?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorRetryable?: boolean | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawJob {
  id: string;
  source: string;
  company: string;
  title: string;
  location?: string;
  remoteType?: string;
  description: string;
  requirements: string[];
  skills: string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  postedAt?: string;
  discoveredAt?: string;
  applicationUrl?: string;
  sourceUrl?: string;
  analysis?: { mustHave?: string[]; niceToHave?: string[]; redFlags?: string[] };
  matches?: Array<{ overall: number; tier: string; matchedSkills?: string[] }>;
  applications?: Array<{ status: string }>;
}

interface RawApplication {
  id: string;
  jobId: string;
  status: string;
  version?: number;
  matchScore?: number;
  atsScore?: number;
  appliedAt?: string;
  createdAt: string;
  retryCount: number;
  failureReason?: string;
  job: { company: string; title: string; location?: string };
  resumeVersion?: { atsScoreOverall?: number };
}

interface RawApplicationDetail extends RawApplication {
  attempts?: Array<{
    id: string;
    attemptNumber: number;
    status: string;
    startedAt: string;
    completedAt?: string;
    error?: string;
    fieldsDetected: number;
    fieldsFilled: number;
  }>;
  interviews?: UIInterview[];
  offers?: OfferRecord[];
  emailOutcomes?: UIEmailOutcome[];
  jobs?: UIApplication['jobs'];
}

interface RawResumeVersion {
  id: string;
  company?: string;
  role?: string;
  atsScoreOverall?: number;
  keywordCoverage?: number;
  generatedAt: string;
  changesFromMaster?: unknown;
  sourceFacts?: unknown;
}

interface RawResume {
  id: string;
  name: string;
  isMaster: boolean;
  fileName?: string;
  createdAt: string;
  updatedAt: string;
  _count?: { sourceFacts: number };
  versions: RawResumeVersion[];
}

function toDiscoveryRunSummary(run: RawDiscoveryRun): DiscoveryRunSummary {
  const statuses: DiscoveryRunStatus[] = ['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'];
  const status = statuses.includes(run.status as DiscoveryRunStatus) ? run.status as DiscoveryRunStatus : 'UNKNOWN';
  const queryData = run.query && typeof run.query === 'object' && !Array.isArray(run.query)
    ? run.query as Record<string, unknown>
    : {};
  const rawSources = Array.isArray(run.sources)
    ? run.sources
    : run.source && run.sourceAccount
      ? [{ provider: run.source, account: run.sourceAccount }]
      : [];
  const sources = rawSources.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const source = value as Record<string, unknown>;
    const provider = String(source.provider ?? source.source ?? '').toUpperCase();
    const account = source.account ?? source.sourceAccount;
    return (provider === 'GREENHOUSE' || provider === 'LEVER' || provider === 'ASHBY') && typeof account === 'string'
      ? [{ provider, account } as const]
      : [];
  });
  const text = (direct: unknown, nested: unknown): string | undefined => {
    const value = typeof direct === 'string' ? direct : nested;
    return typeof value === 'string' && value.trim() ? value : undefined;
  };
  return {
    id: run.id,
    automationJobId: run.automationJobId,
    status,
    sources,
    query: text(run.query, queryData.query),
    location: text(run.location, queryData.location),
    discoveredCount: run.discoveredCount ?? run.itemsFetched ?? 0,
    normalizedCount: run.normalizedCount ?? run.itemsNormalized ?? 0,
    duplicateCount: run.duplicateCount ?? run.itemsDuplicate ?? 0,
    savedCount: run.savedCount ?? ((run.jobsCreated ?? 0) + (run.jobsUpdated ?? 0)),
    failedCount: run.failedCount ?? run.errorCount ?? run.itemsRejected ?? 0,
    errorClass: run.errorClass ?? undefined,
    errorCode: run.errorCode ?? undefined,
    errorMessage: run.errorMessage ?? undefined,
    errorRetryable: run.errorRetryable ?? undefined,
    startedAt: run.startedAt ?? undefined,
    completedAt: run.completedAt ?? undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function toUIJob(job: RawJob): UIJob {
  const match = job.matches?.[0];
  const salary = job.salaryMin || job.salaryMax
    ? `${job.salaryCurrency ?? 'USD'} ${job.salaryMin?.toLocaleString() ?? '?'}–${job.salaryMax?.toLocaleString() ?? '?'}${job.salaryPeriod ? ` / ${job.salaryPeriod.toLowerCase()}` : ''}`
    : 'Not listed';
  return {
    id: job.id,
    source: job.source,
    company: job.company,
    title: job.title,
    location: job.location || 'Location not listed',
    remoteType: job.remoteType,
    salary,
    matchScore: match?.overall,
    tier: match?.tier,
    postedAt: job.postedAt || job.discoveredAt,
    tags: [...new Set([...(match?.matchedSkills ?? []), ...job.skills])].slice(0, 8),
    description: job.description,
    mustHave: job.analysis?.mustHave ?? job.requirements,
    niceToHave: job.analysis?.niceToHave ?? [],
    redFlags: job.analysis?.redFlags ?? [],
    sourceUrl: job.sourceUrl,
    applicationUrl: job.applicationUrl,
    applicationStatus: job.applications?.[0]?.status,
  };
}

function toUIApplication(app: RawApplication): UIApplication {
  return {
    id: app.id,
    jobId: app.jobId,
    company: app.job.company,
    role: app.job.title,
    location: app.job.location,
    status: app.status,
    version: app.version,
    matchScore: app.matchScore,
    atsScore: app.atsScore ?? app.resumeVersion?.atsScoreOverall,
    appliedAt: app.appliedAt,
    createdAt: app.createdAt,
    retryCount: app.retryCount,
    failureReason: app.failureReason,
  };
}

function toAttempt(attempt: NonNullable<RawApplicationDetail['attempts']>[number]): ApplicationAttempt {
  return attempt;
}

function toResumeVersion(resume: RawResume, version: RawResumeVersion): UIResumeVersion {
  const changes = Array.isArray(version.changesFromMaster)
    ? version.changesFromMaster.filter((value): value is string => typeof value === 'string')
    : [];
  const provenance = Array.isArray(version.sourceFacts)
    ? version.sourceFacts.flatMap((value) => {
        if (!value || typeof value !== 'object') return [];
        const fact = value as Record<string, unknown>;
        return typeof fact.claim === 'string'
          ? [{ claim: fact.claim, source: String(fact.sourceField ?? 'Resume source'), verified: fact.verified === true }]
          : [];
      })
    : [];
  return {
    id: version.id,
    resumeId: resume.id,
    name: `${version.company && version.role ? `${version.company} — ${version.role}` : resume.name}`,
    company: version.company,
    role: version.role,
    atsScore: version.atsScoreOverall,
    keywordCoverage: version.keywordCoverage ?? 0,
    generatedAt: version.generatedAt,
    changes,
    provenance,
  };
}
