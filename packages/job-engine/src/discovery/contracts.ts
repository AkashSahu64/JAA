import { createHash } from 'node:crypto';

export type JobSource = 'greenhouse' | 'lever' | 'ashby';
export type DiscoveryErrorKind = 'aborted' | 'timeout' | 'network' | 'http' | 'invalid-response';

export interface FetchLike {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface DiscoveryAdapterOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
}

export interface DiscoveryRequest {
  query?: string;
  location?: string;
  pageSize?: number;
  cursor?: string;
  signal?: AbortSignal;
}

export interface SourceProvenance {
  source: JobSource;
  tenant: string;
  sourceJobId: string;
  fetchedAt: string;
  apiUrl: string;
}

export interface NormalizedDiscoveryJob {
  source: JobSource;
  sourceJobId: string;
  company: string;
  title: string;
  location?: string;
  department?: string;
  description: string;
  employmentType?: string;
  postedAt?: string;
  applicationUrl: string;
  sourceUrl: string;
  fingerprint: string;
  provenance: SourceProvenance;
}

export interface PageMetadata {
  pageSize: number;
  returned: number;
  nextCursor?: string;
  hasMore: boolean;
}

export interface DiscoveryItemRejection {
  source: JobSource;
  /** Zero-based position in the provider response (or native provider result set). */
  providerIndex: number;
  /** Exact provider value; consumers must not synthesize missing identity fields. */
  raw: unknown;
  error: {
    kind: 'invalid-response';
    message: string;
  };
}

export interface DiscoveryPage {
  jobs: NormalizedDiscoveryJob[];
  /** Entries rejected during normalization. Optional for backwards-compatible executors. */
  rejections?: DiscoveryItemRejection[];
  page: PageMetadata;
}

export class DiscoveryError extends Error {
  public readonly retryAfterMs?: number;

  constructor(
    public readonly kind: DiscoveryErrorKind,
    message: string,
    public readonly source: JobSource,
    public readonly status?: number,
    options?: ErrorOptions,
    retryAfterMs?: number,
    public readonly restartWithoutCursor = false,
  ) {
    super(message, options);
    if (retryAfterMs !== undefined && (!Number.isFinite(retryAfterMs) || retryAfterMs < 0)) {
      throw new RangeError('retryAfterMs must be a non-negative finite number');
    }
    this.retryAfterMs = retryAfterMs;
    this.name = 'DiscoveryError';
  }
}

export function normalizedFingerprint(job: Pick<NormalizedDiscoveryJob, 'source' | 'sourceJobId' | 'company' | 'title' | 'location'>): string {
  const canonical = [job.source, job.sourceJobId, job.company, job.title, job.location ?? '']
    .map(value => value.normalize('NFKC').trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' '))
    .join('');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function safePublicUrl(value: unknown, source: JobSource): string {
  if (typeof value !== 'string') throw new DiscoveryError('invalid-response', 'Job URL is missing', source);
  let url: URL;
  try { url = new URL(value); } catch (cause) {
    throw new DiscoveryError('invalid-response', 'Job URL is invalid', source, undefined, { cause });
  }
  if (url.protocol !== 'https:') throw new DiscoveryError('invalid-response', 'Job URL must use HTTPS', source);
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function pageSize(value?: number): number {
  return Number.isInteger(value) ? Math.min(100, Math.max(1, value as number)) : 25;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined, source: JobSource): number {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { offset?: unknown };
    if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) throw new Error('bad offset');
    return value.offset as number;
  } catch (cause) {
    throw new DiscoveryError('invalid-response', 'Invalid discovery cursor', source, undefined, { cause });
  }
}
