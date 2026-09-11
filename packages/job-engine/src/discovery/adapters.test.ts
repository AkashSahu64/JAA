import { describe, expect, it, vi } from 'vitest';
import { AshbyPublicApiAdapter, DiscoveryError, GreenhousePublicApiAdapter, LeverPublicApiAdapter } from './index';

const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
});

const greenhouseFixture = { jobs: [{ id: 7, title: 'Senior TypeScript Engineer', location: { name: 'Remote' }, content: '<p>Build APIs with TypeScript</p>', departments: [{ name: 'Engineering' }], updated_at: '2026-01-02T03:04:05Z', absolute_url: 'https://jobs.example.invalid/greenhouse/7#apply' }] };
const leverFixture = [{ id: 'lev-1', text: 'Platform Engineer', categories: { location: 'Berlin', department: 'Engineering', commitment: 'Full-time' }, descriptionPlain: 'Build services', lists: [{ text: 'Requirements', content: '<li>TypeScript</li>' }], hostedUrl: 'https://jobs.example.invalid/lever/lev-1', applyUrl: 'https://jobs.example.invalid/lever/lev-1/apply', createdAt: 1767225600000 }];
const ashbyFixture = { jobs: [{ id: 'ash-1', title: 'Data Engineer', location: 'Toronto', workplaceType: 'Hybrid', department: 'Data', employmentType: 'FullTime', descriptionHtml: '<p>Build pipelines</p>', publishedAt: '2026-01-01T00:00:00Z', jobUrl: 'https://jobs.example.invalid/ashby/ash-1', applyUrl: 'https://jobs.example.invalid/ashby/ash-1/apply' }] };

describe('public API discovery adapters', () => {
  it.each([
    ['greenhouse', (fetch: typeof globalThis.fetch) => new GreenhousePublicApiAdapter('example', { fetch }), greenhouseFixture, '7'],
    ['lever', (fetch: typeof globalThis.fetch) => new LeverPublicApiAdapter('example', { fetch }), leverFixture, 'lev-1'],
    ['ashby', (fetch: typeof globalThis.fetch) => new AshbyPublicApiAdapter('example', { fetch }), ashbyFixture, 'ash-1'],
  ] as const)('normalizes %s fixtures with provenance and stable fingerprints', async (source, factory, fixture, id) => {
    const fetch = vi.fn(async () => response(fixture));
    const adapter = factory(fetch as unknown as typeof globalThis.fetch);
    const first = await adapter.discover();
    const second = await adapter.discover();
    expect(first.jobs[0]).toMatchObject({ source, sourceJobId: id, company: 'example', provenance: { source, tenant: 'example', sourceJobId: id } });
    expect(first.jobs[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.jobs[0].fingerprint).toBe(second.jobs[0].fingerprint);
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'https:' }), expect.objectContaining({ method: 'GET', signal: expect.any(AbortSignal) }));
  });

  it('returns opaque cursor metadata deterministically', async () => {
    const jobs = { jobs: [greenhouseFixture.jobs[0], { ...greenhouseFixture.jobs[0], id: 8, title: 'Staff Engineer', absolute_url: 'https://jobs.example.invalid/greenhouse/8' }] };
    const adapter = new GreenhousePublicApiAdapter('example', { fetch: async () => response(jobs) });
    const first = await adapter.discover({ pageSize: 1 });
    expect(first.page).toMatchObject({ pageSize: 1, returned: 1, hasMore: true });
    const second = await adapter.discover({ pageSize: 1, cursor: first.page.nextCursor });
    expect(second.jobs[0].sourceJobId).toBe('8');
    expect(second.page.hasMore).toBe(false);
  });

  it('uses Lever native paging with overlap continuity and avoids full-list refetches', async () => {
    const postings = Array.from({ length: 5 }, (_, index) => ({
      ...leverFixture[0], id: `lev-${index + 1}`, text: `Engineer ${index + 1}`,
      hostedUrl: `https://jobs.example.invalid/lever/lev-${index + 1}`,
      applyUrl: `https://jobs.example.invalid/lever/lev-${index + 1}/apply`,
    }));
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const skip = Number(url.searchParams.get('skip'));
      const limit = Number(url.searchParams.get('limit'));
      return response(postings.slice(skip, skip + limit));
    });
    const adapter = new LeverPublicApiAdapter('example', { fetch });
    const first = await adapter.discover({ pageSize: 2 });
    const second = await adapter.discover({ pageSize: 2, cursor: first.page.nextCursor });

    expect(first.jobs.map(job => job.sourceJobId)).toEqual(['lev-1', 'lev-2']);
    expect(second.jobs.map(job => job.sourceJobId)).toEqual(['lev-3', 'lev-4']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get('skip')).toBe('0');
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('skip')).toBe('1');
  });

  it('rejects a Lever continuation when an insertion shifts the overlap anchor', async () => {
    const posting = (id: string) => ({ ...leverFixture[0], id, hostedUrl: `https://jobs.example.invalid/${id}`, applyUrl: `https://jobs.example.invalid/${id}/apply` });
    let postings = ['a', 'b', 'c'].map(posting);
    const adapter = new LeverPublicApiAdapter('example', { fetch: async input => {
      const url = new URL(input instanceof Request ? input.url : input);
      const skip = Number(url.searchParams.get('skip'));
      const limit = Number(url.searchParams.get('limit'));
      return response(postings.slice(skip, skip + limit));
    } });
    const first = await adapter.discover({ pageSize: 1 });
    postings = ['new', 'a', 'b', 'c'].map(posting);
    await expect(adapter.discover({ pageSize: 1, cursor: first.page.nextCursor })).rejects.toMatchObject({
      kind: 'invalid-response', restartWithoutCursor: true,
    });
  });

  it.each([
    ['greenhouse', (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new GreenhousePublicApiAdapter('example', { fetch }), greenhouseFixture.jobs[0]],
    ['lever', (jobs: unknown[]) => jobs, (fetch: typeof globalThis.fetch) => new LeverPublicApiAdapter('example', { fetch }), leverFixture[0]],
    ['ashby', (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new AshbyPublicApiAdapter('example', { fetch }), ashbyFixture.jobs[0]],
  ] as const)('preserves valid %s jobs and reports malformed entries without inventing identity', async (_source, wrap, factory, valid) => {
    const malformed = { unexpected: true };
    const adapter = factory(async () => response(wrap([malformed, valid])));
    const page = await adapter.discover();

    expect(page.jobs).toHaveLength(1);
    expect(page.rejections).toEqual([expect.objectContaining({
      source: _source,
      providerIndex: 0,
      raw: malformed,
      error: { kind: 'invalid-response', message: expect.any(String) },
    })]);
    expect(page.rejections?.[0]).not.toHaveProperty('sourceJobId');
  });

  it('keeps Lever native offsets correct when malformed entries are rejected', async () => {
    const postings = [leverFixture[0], { broken: true }, { ...leverFixture[0], id: 'lev-2' }];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return response(postings.slice(Number(url.searchParams.get('skip')), Number(url.searchParams.get('skip')) + Number(url.searchParams.get('limit'))));
    });
    const adapter = new LeverPublicApiAdapter('example', { fetch });
    const first = await adapter.discover({ pageSize: 1 });
    const second = await adapter.discover({ pageSize: 1, cursor: first.page.nextCursor });

    expect(first.jobs.map(job => job.sourceJobId)).toEqual(['lev-1']);
    expect(first.rejections).toHaveLength(1);
    expect(second.jobs.map(job => job.sourceJobId)).toEqual(['lev-2']);
  });

  it.each([
    ['greenhouse', () => ({ jobs: [] }), (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new GreenhousePublicApiAdapter('example', { fetch })],
    ['ashby', () => ({ jobs: [] }), (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new AshbyPublicApiAdapter('example', { fetch })],
  ] as const)('rebases %s local cursors after insertions before the last emitted job', async (_source, _empty, wrap, factory) => {
    const base = _source === 'greenhouse' ? greenhouseFixture.jobs[0] : ashbyFixture.jobs[0];
    const make = (id: string) => _source === 'greenhouse'
      ? { ...base, id: Number(id), absolute_url: `https://jobs.example.invalid/${id}` }
      : { ...base, id, jobUrl: `https://jobs.example.invalid/${id}`, applyUrl: `https://jobs.example.invalid/${id}/apply` };
    let payload = wrap([make('1'), make('2')]);
    const adapter = factory(async () => response(payload));
    const first = await adapter.discover({ pageSize: 1 });
    payload = wrap([make('0'), make('1'), make('2')]);
    const second = await adapter.discover({ pageSize: 1, cursor: first.page.nextCursor });
    expect(second.jobs.map(job => job.sourceJobId)).toEqual(['2']);
  });

  it.each([
    ['greenhouse', (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new GreenhousePublicApiAdapter('example', { fetch })],
    ['ashby', (jobs: unknown[]) => ({ jobs }), (fetch: typeof globalThis.fetch) => new AshbyPublicApiAdapter('example', { fetch })],
  ] as const)('signals restart when the %s continuation anchor disappears', async (_source, wrap, factory) => {
    const base = _source === 'greenhouse' ? greenhouseFixture.jobs[0] : ashbyFixture.jobs[0];
    const make = (id: string) => _source === 'greenhouse'
      ? { ...base, id: Number(id), absolute_url: `https://jobs.example.invalid/${id}` }
      : { ...base, id, jobUrl: `https://jobs.example.invalid/${id}`, applyUrl: `https://jobs.example.invalid/${id}/apply` };
    let payload = wrap([make('1'), make('2')]);
    const adapter = factory(async () => response(payload));
    const first = await adapter.discover({ pageSize: 1 });
    payload = wrap([make('2')]);
    await expect(adapter.discover({ pageSize: 1, cursor: first.page.nextCursor })).rejects.toMatchObject({
      kind: 'invalid-response', restartWithoutCursor: true,
    });
  });

  it('defaults ordinary discovery errors to no cursor restart', () => {
    expect(new DiscoveryError('invalid-response', 'bad payload', 'greenhouse')).toMatchObject({
      restartWithoutCursor: false,
    });
  });

  it('reports unsafe source URLs as item rejections', async () => {
    const fixture = { jobs: [{ ...greenhouseFixture.jobs[0], absolute_url: 'javascript:alert(1)' }] };
    const adapter = new GreenhousePublicApiAdapter('example', { fetch: async () => response(fixture) });
    const page = await adapter.discover();
    expect(page.jobs).toEqual([]);
    expect(page.rejections).toEqual([expect.objectContaining({
      error: { kind: 'invalid-response', message: 'Job URL must use HTTPS' },
      raw: fixture.jobs[0],
    })]);
  });

  it('parses valid Retry-After headers on HTTP failures', async () => {
    const now = Date.parse('Thu, 01 Jan 2026 00:00:00 GMT');
    const cases = [
      ['0', 0],
      ['2.5', 2_500],
      ['Thu, 01 Jan 2026 00:00:03 GMT', 3_000],
    ] as const;

    for (const [header, retryAfterMs] of cases) {
      const adapter = new LeverPublicApiAdapter('example', {
        fetch: async () => response({}, 429, { 'retry-after': header }),
        now: () => now,
      });
      await expect(adapter.discover()).rejects.toMatchObject({
        kind: 'http',
        status: 429,
        retryAfterMs,
      });
    }
  });

  it.each(['-1', 'Infinity', 'NaN', 'soon'])('ignores invalid Retry-After header %s', async header => {
    const adapter = new LeverPublicApiAdapter('example', {
      fetch: async () => response({}, 503, { 'retry-after': header }),
      now: () => Date.parse('Thu, 01 Jan 2026 00:00:00 GMT'),
    });
    await expect(adapter.discover()).rejects.toMatchObject({
      kind: 'http',
      status: 503,
      retryAfterMs: undefined,
    });
  });

  it('validates explicit DiscoveryError retry delays', () => {
    expect(new DiscoveryError('http', 'rate limited', 'lever', 429, undefined, 0)).toMatchObject({ retryAfterMs: 0 });
    expect(() => new DiscoveryError('http', 'rate limited', 'lever', 429, undefined, -1)).toThrow(RangeError);
    expect(() => new DiscoveryError('http', 'rate limited', 'lever', 429, undefined, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => new DiscoveryError('http', 'rate limited', 'lever', 429, undefined, Number.NaN)).toThrow(RangeError);
  });

  it('classifies HTTP, timeout, and caller abort errors', async () => {
    const http = new LeverPublicApiAdapter('example', { fetch: async () => response({}, 429) });
    await expect(http.discover()).rejects.toMatchObject({ kind: 'http', status: 429 });

    const pending = (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }));
    const timeout = new AshbyPublicApiAdapter('example', { fetch: pending, timeoutMs: 5 });
    await expect(timeout.discover()).rejects.toMatchObject({ kind: 'timeout' });

    const controller = new AbortController();
    const aborted = new AshbyPublicApiAdapter('example', { fetch: pending, timeoutMs: 1000 });
    const result = aborted.discover({ signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toEqual(expect.objectContaining<Partial<DiscoveryError>>({ kind: 'aborted' }));

    const alreadyAbortedController = new AbortController();
    alreadyAbortedController.abort();
    await expect(aborted.discover({ signal: alreadyAbortedController.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });
});
