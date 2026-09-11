import { createHash } from 'node:crypto';
import { PublicApiAdapter, arrayValue, objectValue, optionalString, stringValue } from './base';
import { DiscoveryAdapterOptions, DiscoveryError, DiscoveryItemRejection, DiscoveryPage, DiscoveryRequest, NormalizedDiscoveryJob, cleanText, normalizedFingerprint, pageSize, safePublicUrl } from './contracts';

interface LeverCursor { offset: number; anchorId?: string; }

export class LeverPublicApiAdapter extends PublicApiAdapter {
  readonly source = 'lever' as const;
  constructor(private readonly companySlug: string, options: DiscoveryAdapterOptions = {}) {
    super(options);
    if (!/^[a-z0-9_-]+$/i.test(companySlug)) throw new TypeError('Invalid Lever company slug');
  }

  async discover(request: DiscoveryRequest = {}): Promise<DiscoveryPage> {
    const size = pageSize(request.pageSize);
    const cursor = this.decodeLeverCursor(request.cursor);
    const fetchedAt = new Date().toISOString();
    const matches: NormalizedDiscoveryJob[] = [];
    const rejections: DiscoveryItemRejection[] = [];
    const batchLimit = Math.max(3, Math.min(100, size + 2));
    let offset = cursor.offset;
    let anchorId = cursor.anchorId;
    let nextCursor: string | undefined;

    // Lever natively supports skip/limit. Every continuation request overlaps one
    // posting and verifies its id, turning offset drift into an explicit restart
    // instead of silently skipping or repeating a posting.
    while (matches.length <= size) {
      const overlap = offset > 0 && anchorId !== undefined;
      const requestOffset = overlap ? offset - 1 : offset;
      const url = new URL(`https://api.lever.co/v0/postings/${encodeURIComponent(this.companySlug)}`);
      url.searchParams.set('mode', 'json');
      url.searchParams.set('skip', String(requestOffset));
      url.searchParams.set('limit', String(batchLimit));
      const values = arrayValue(await this.getJson(url, request.signal), this.source);
      let index = 0;

      if (overlap) {
        if (values.length === 0 || this.rawIdentity(values[0]) !== anchorId) {
          throw new DiscoveryError(
            'invalid-response',
            'lever job listing changed while paging; restart discovery without a cursor',
            this.source,
            undefined,
            undefined,
            undefined,
            true,
          );
        }
        index = 1;
      }

      for (; index < values.length; index += 1) {
        const normalized = this.normalizeItems(
          [values[index]],
          value => this.normalize(value, url, fetchedAt),
          requestOffset + index,
        );
        const job = normalized.jobs[0];
        if (!job) {
          rejections.push(...normalized.rejections);
          anchorId = this.rawIdentity(values[index]);
          offset += 1;
          continue;
        }
        if (this.filter([job], request).length > 0) {
          if (matches.length === size) {
            nextCursor = this.encodeLeverCursor(offset, anchorId);
            break;
          }
          matches.push(job);
        }
        anchorId = job.sourceJobId;
        offset += 1;
      }
      if (nextCursor || values.length < batchLimit) break;
      if (index === 0 && values.length === 0) break;
    }

    return {
      jobs: matches,
      rejections,
      page: { pageSize: size, returned: matches.length, hasMore: nextCursor !== undefined, nextCursor },
    };
  }

  private rawIdentity(value: unknown): string {
    try {
      return this.jobId(value);
    } catch {
      return `malformed:${createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('base64url')}`;
    }
  }

  private jobId(value: unknown): string {
    return stringValue(objectValue(value, this.source, 'job').id, this.source, 'job id');
  }

  private encodeLeverCursor(offset: number, anchorId?: string): string {
    return Buffer.from(JSON.stringify({ v: 1, offset, anchorId }), 'utf8').toString('base64url');
  }

  private decodeLeverCursor(value?: string): LeverCursor {
    if (!value) return { offset: 0 };
    try {
      const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (!Number.isSafeInteger(cursor.offset) || (cursor.offset as number) < 0) throw new Error('bad offset');
      if (cursor.anchorId !== undefined && (typeof cursor.anchorId !== 'string' || !cursor.anchorId)) throw new Error('bad anchor');
      return { offset: cursor.offset as number, anchorId: cursor.anchorId as string | undefined };
    } catch (cause) {
      throw new DiscoveryError('invalid-response', 'Invalid discovery cursor', this.source, undefined, { cause });
    }
  }

  private normalize(value: unknown, apiUrl: URL, fetchedAt: string): NormalizedDiscoveryJob {
    const job = objectValue(value, this.source, 'job');
    const categories = job.categories && typeof job.categories === 'object' ? job.categories as Record<string, unknown> : {};
    const lists = Array.isArray(job.lists) ? job.lists : [];
    const description = cleanText([job.descriptionPlain, ...lists.map(item => item && typeof item === 'object' ? (item as Record<string, unknown>).content : '')].join('\n'));
    const sourceJobId = stringValue(job.id, this.source, 'job id');
    const sourceUrl = safePublicUrl(job.hostedUrl, this.source);
    const result: Omit<NormalizedDiscoveryJob, 'fingerprint'> = {
      source: this.source, sourceJobId, company: this.companySlug,
      title: stringValue(job.text, this.source, 'title'), location: optionalString(categories.location),
      department: optionalString(categories.department), description,
      employmentType: optionalString(categories.commitment),
      postedAt: typeof job.createdAt === 'number' && Number.isFinite(job.createdAt) ? new Date(job.createdAt).toISOString() : undefined,
      applicationUrl: safePublicUrl(job.applyUrl, this.source), sourceUrl,
      provenance: { source: this.source, tenant: this.companySlug, sourceJobId, fetchedAt, apiUrl: apiUrl.toString() },
    };
    return { ...result, fingerprint: normalizedFingerprint(result) };
  }
}
