import { PublicApiAdapter, arrayValue, objectValue, optionalString, snapshotPage, stringValue } from './base';
import { DiscoveryAdapterOptions, DiscoveryPage, DiscoveryRequest, NormalizedDiscoveryJob, cleanText, normalizedFingerprint, safePublicUrl } from './contracts';

export class AshbyPublicApiAdapter extends PublicApiAdapter {
  readonly source = 'ashby' as const;
  constructor(private readonly organizationSlug: string, options: DiscoveryAdapterOptions = {}) {
    super(options);
    if (!/^[a-z0-9_-]+$/i.test(organizationSlug)) throw new TypeError('Invalid Ashby organization slug');
  }

  async discover(request: DiscoveryRequest = {}): Promise<DiscoveryPage> {
    // Ashby's unauthenticated posting API returns a full snapshot and exposes no
    // pagination. Snapshot-bound cursors make an intervening mutation explicit.
    const url = new URL(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(this.organizationSlug)}`);
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
    const sourceJobId = stringValue(job.id, this.source, 'job id');
    const sourceUrl = safePublicUrl(job.jobUrl, this.source);
    const location = optionalString(job.location);
    const workplaceType = optionalString(job.workplaceType);
    const result: Omit<NormalizedDiscoveryJob, 'fingerprint'> = {
      source: this.source, sourceJobId, company: this.organizationSlug,
      title: stringValue(job.title, this.source, 'title'),
      location: workplaceType && location ? `${location} (${workplaceType})` : location ?? workplaceType,
      department: optionalString(job.department), description: cleanText(job.descriptionHtml ?? job.descriptionPlain),
      employmentType: optionalString(job.employmentType),
      postedAt: optionalString(job.publishedAt),
      applicationUrl: safePublicUrl(job.applyUrl ?? job.jobUrl, this.source), sourceUrl,
      provenance: { source: this.source, tenant: this.organizationSlug, sourceJobId, fetchedAt, apiUrl: apiUrl.toString() },
    };
    return { ...result, fingerprint: normalizedFingerprint(result) };
  }
}
