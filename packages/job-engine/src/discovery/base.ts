import { createHash } from 'node:crypto';
import { DiscoveryAdapterOptions, DiscoveryError, DiscoveryItemRejection, DiscoveryPage, DiscoveryRequest, FetchLike, JobSource, NormalizedDiscoveryJob, decodeCursor, encodeCursor, pageSize } from './contracts';

export abstract class PublicApiAdapter {
  protected readonly fetch: FetchLike;
  protected readonly timeoutMs: number;
  protected readonly now: () => number;
  abstract readonly source: JobSource;

  protected constructor(options: DiscoveryAdapterOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.now = options.now ?? Date.now;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new RangeError('timeoutMs must be positive');
  }

  abstract discover(request?: DiscoveryRequest): Promise<DiscoveryPage>;

  protected paginate(jobs: NormalizedDiscoveryJob[], request: DiscoveryRequest): DiscoveryPage {
    const offset = decodeCursor(request.cursor, this.source);
    const size = pageSize(request.pageSize);
    const selected = jobs.slice(offset, offset + size);
    const nextOffset = offset + selected.length;
    const hasMore = nextOffset < jobs.length;
    return { jobs: selected, page: { pageSize: size, returned: selected.length, hasMore, nextCursor: hasMore ? encodeCursor(nextOffset) : undefined } };
  }

  protected normalizeItems(
    values: unknown[],
    normalize: (value: unknown, providerIndex: number) => NormalizedDiscoveryJob,
    providerOffset = 0,
  ): { jobs: NormalizedDiscoveryJob[]; rejections: DiscoveryItemRejection[] } {
    const jobs: NormalizedDiscoveryJob[] = [];
    const rejections: DiscoveryItemRejection[] = [];
    for (const [index, value] of values.entries()) {
      try {
        jobs.push(normalize(value, providerOffset + index));
      } catch (error) {
        if (!(error instanceof DiscoveryError) || error.kind !== 'invalid-response') throw error;
        rejections.push({
          source: this.source,
          providerIndex: providerOffset + index,
          raw: value,
          error: { kind: 'invalid-response', message: error.message },
        });
      }
    }
    return { jobs, rejections };
  }

  protected filter(jobs: NormalizedDiscoveryJob[], request: DiscoveryRequest): NormalizedDiscoveryJob[] {
    const query = request.query?.trim().toLocaleLowerCase('en-US');
    const location = request.location?.trim().toLocaleLowerCase('en-US');
    return jobs.filter(job => (!query || `${job.title} ${job.description}`.toLocaleLowerCase('en-US').includes(query)) &&
      (!location || (job.location ?? '').toLocaleLowerCase('en-US').includes(location)));
  }

  protected async getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(new Error('timeout')), this.timeoutMs);
    let callerAborted = signal?.aborted ?? false;
    const abortFromCaller = () => { callerAborted = true; timeoutController.abort(signal?.reason); };
    if (callerAborted) timeoutController.abort(signal?.reason);
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (timeoutController.signal.aborted) {
      clearTimeout(timer);
      throw new DiscoveryError('aborted', `${this.source} request was aborted`, this.source);
    }
    try {
      const response = await this.fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: timeoutController.signal });
      if (!response.ok) {
        throw new DiscoveryError(
          'http',
          `${this.source} API returned HTTP ${response.status}`,
          this.source,
          response.status,
          undefined,
          retryAfterMs(response.headers.get('retry-after'), this.now()),
        );
      }
      try { return await response.json(); } catch (cause) {
        throw new DiscoveryError('invalid-response', `${this.source} API returned invalid JSON`, this.source, response.status, { cause });
      }
    } catch (cause) {
      if (cause instanceof DiscoveryError) throw cause;
      if (callerAborted) throw new DiscoveryError('aborted', `${this.source} request was aborted`, this.source, undefined, { cause });
      if (timeoutController.signal.aborted) throw new DiscoveryError('timeout', `${this.source} request timed out after ${this.timeoutMs}ms`, this.source, undefined, { cause });
      throw new DiscoveryError('network', `${this.source} request failed`, this.source, undefined, { cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }
}

export function objectValue(value: unknown, source: JobSource, label = 'response'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DiscoveryError('invalid-response', `${source} ${label} must be an object`, source);
  return value as Record<string, unknown>;
}

export function arrayValue(value: unknown, source: JobSource, label = 'jobs'): unknown[] {
  if (!Array.isArray(value)) throw new DiscoveryError('invalid-response', `${source} ${label} must be an array`, source);
  return value;
}

export function stringValue(value: unknown, source: JobSource, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DiscoveryError('invalid-response', `${source} ${label} is missing`, source);
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export interface SnapshotCursor {
  offset: number;
  anchorId?: string;
  snapshot?: string;
}

export function snapshotPage(
  source: JobSource,
  jobs: NormalizedDiscoveryJob[],
  rejections: DiscoveryItemRejection[],
  request: DiscoveryRequest,
): DiscoveryPage {
  const cursor = decodeSnapshotCursor(request.cursor, source);
  const snapshot = createHash('sha256').update(JSON.stringify({
    query: request.query?.trim() ?? '',
    location: request.location?.trim() ?? '',
    jobs: jobs.map(job => job.sourceJobId),
    rejected: rejections.map(rejection => rejection.providerIndex),
  })).digest('base64url');
  let offset = cursor.offset;
  if (cursor.snapshot !== undefined && cursor.snapshot !== snapshot) {
    const anchorIndex = cursor.anchorId === undefined
      ? -1
      : jobs.findIndex(job => job.sourceJobId === cursor.anchorId);
    if (anchorIndex < 0) {
      throw new DiscoveryError(
        'invalid-response',
        `${source} job listing changed while paging and the continuation anchor disappeared; restart discovery without a cursor`,
        source,
        undefined,
        undefined,
        undefined,
        true,
      );
    }
    // Rebase after the last emitted item. This is stateless and therefore retains
    // crash-resume semantics while allowing insertions/removals before the anchor.
    offset = anchorIndex + 1;
  }
  const size = pageSize(request.pageSize);
  const selected = jobs.slice(offset, offset + size);
  const nextOffset = offset + selected.length;
  const hasMore = nextOffset < jobs.length;
  const anchorId = selected.at(-1)?.sourceJobId ?? cursor.anchorId;
  const nextCursor = hasMore
    ? Buffer.from(JSON.stringify({ v: 2, offset: nextOffset, anchorId, snapshot }), 'utf8').toString('base64url')
    : undefined;
  return {
    jobs: selected,
    rejections: cursor.offset === 0 ? rejections : [],
    page: { pageSize: size, returned: selected.length, hasMore, nextCursor },
  };
}

function decodeSnapshotCursor(value: string | undefined, source: JobSource): SnapshotCursor {
  if (!value) return { offset: 0 };
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw new Error('bad offset');
    if (cursor.anchorId !== undefined && (typeof cursor.anchorId !== 'string' || !cursor.anchorId)) throw new Error('bad anchor');
    if (cursor.snapshot !== undefined && typeof cursor.snapshot !== 'string') throw new Error('bad snapshot');
    return {
      offset: cursor.offset as number,
      anchorId: cursor.anchorId as string | undefined,
      snapshot: cursor.snapshot as string | undefined,
    };
  } catch (cause) {
    throw new DiscoveryError('invalid-response', 'Invalid discovery cursor', source, undefined, { cause });
  }
}

function retryAfterMs(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const milliseconds = Number(trimmed) * 1_000;
    return Number.isFinite(milliseconds) ? milliseconds : undefined;
  }
  const dateMs = Date.parse(trimmed);
  const milliseconds = dateMs - nowMs;
  return Number.isFinite(dateMs) && Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
}
