import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decideResumeFact, fetchNotifications, fetchResumeFacts, fetchResumes, markAllNotificationsRead } from './api';

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
