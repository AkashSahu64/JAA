import { PublicApiAdapter, arrayValue, objectValue, optionalString, snapshotPage, stringValue } from './base';
import { DiscoveryAdapterOptions, DiscoveryError, DiscoveryPage, DiscoveryRequest, NormalizedDiscoveryJob, cleanText, normalizedFingerprint, safePublicUrl } from './contracts';

export class GreenhousePublicApiAdapter extends PublicApiAdapter {
  readonly source = 'greenhouse' as const;
  constructor(private readonly boardToken: string, options: DiscoveryAdapterOptions = {}) {
    super(options);
    if (!/^[a-z0-9_-]+$/i.test(boardToken)) throw new TypeError('Invalid Greenhouse board token');
  }

  async discover(request: DiscoveryRequest = {}): Promise<DiscoveryPage> {
    // Greenhouse's public Job Board API has no provider-side pagination. Bind the
    // local cursor to the fetched ordering so a changed snapshot cannot silently
    // shift an offset and skip or repeat jobs between calls.
    const url = new URL(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(this.boardToken)}/jobs`);
    url.searchParams.set('content', 'true');
    const body = objectValue(await this.getJson(url, request.signal), this.source);
    const fetchedAt = new Date().toISOString();
    const normalized = this.normalizeItems(
      arrayValue(body.jobs, this.source),
      value => this.normalize(value, url, fetchedAt),
    );
    const jobs = this.filter(normalized.jobs, request);
    return snapshotPage(this.source, jobs, normalized.rejections, request);
  }

  private normalize(value: unknown, apiUrl: URL, fetchedAt: string): NormalizedDiscoveryJob {
    const job = objectValue(value, this.source, 'job');
    const locationValue = job.location && typeof job.location === 'object' ? optionalString((job.location as Record<string, unknown>).name) : undefined;
    const departments = Array.isArray(job.departments) ? job.departments : [];
    const department = departments.map(item => item && typeof item === 'object' ? optionalString((item as Record<string, unknown>).name) : undefined).filter(Boolean).join(', ') || undefined;
    const idValue = job.id;
    if ((typeof idValue !== 'string' && typeof idValue !== 'number') || !String(idValue).trim()) {
      throw new DiscoveryError('invalid-response', 'greenhouse job id is missing', this.source);
    }
    const sourceJobId = String(idValue);
    const sourceUrl = safePublicUrl(job.absolute_url, this.source);
    const result: Omit<NormalizedDiscoveryJob, 'fingerprint'> = {
      source: this.source, sourceJobId, company: this.boardToken,
      title: stringValue(job.title, this.source, 'title'), location: locationValue, department,
      description: cleanText(job.content), postedAt: optionalString(job.updated_at),
      applicationUrl: sourceUrl, sourceUrl,
      provenance: { source: this.source, tenant: this.boardToken, sourceJobId, fetchedAt, apiUrl: apiUrl.toString() },
    };
    return { ...result, fingerprint: normalizedFingerprint(result) };
  }
}
