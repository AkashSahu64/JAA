import { randomUUID } from 'node:crypto';
import { JobSourceAdapter, NormalizedJob, SearchParams } from './adapters/base';
import { DeduplicationEngine, DeduplicationCandidate } from './deduplication';

export interface DiscoveryResult {
  runId: string;
  totalDiscovered: number;
  afterDeduplication: number;
  duplicatesRemoved: number;
  jobs: Array<NormalizedJob & { id: string; fingerprint: string; duplicateGroupId: string; duplicateCount: number }>;
  errors: Array<{ source: string; error: string }>;
  duration: number;
}

export class JobDiscoveryEngine {
  private adapters: JobSourceAdapter[] = [];
  private deduplicator = new DeduplicationEngine();

  registerAdapter(adapter: JobSourceAdapter): void {
    this.adapters.push(adapter);
  }

  removeAdapter(name: string): void {
    this.adapters = this.adapters.filter(a => a.name !== name);
  }

  getAdapters(): Array<{ name: string; type: string }> {
    return this.adapters.map(a => ({ name: a.name, type: a.type }));
  }

  async discover(params: SearchParams): Promise<DiscoveryResult> {
    const runId = randomUUID();
    const startTime = Date.now();
    const allJobs: NormalizedJob[] = [];
    const errors: Array<{ source: string; error: string }> = [];

    // Search all adapters in parallel
    const results = await Promise.allSettled(
      this.adapters.map(async adapter => {
        const available = await adapter.isAvailable();
        if (!available) {
          throw new Error(`${adapter.name} is not available`);
        }
        const jobs = await adapter.search(params);
        return { source: adapter.name, jobs };
      })
    );

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        allJobs.push(...result.value.jobs);
      } else {
        const reason = result.reason;
        errors.push({
          source: this.adapters[index]?.name ?? 'unknown',
          error: reason instanceof Error ? reason.message : String(reason)
        });
      }
    });

    // Assign IDs and generate fingerprints
    const candidates: DeduplicationCandidate[] = allJobs.map(job => {
      const id = randomUUID();
      return {
        id,
        source: job.source,
        sourceJobId: job.sourceJobId,
        company: job.company,
        title: job.title,
        normalizedTitle: job.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(),
        location: job.location,
        description: job.description,
        applicationUrl: job.applicationUrl,
        sourceUrl: job.sourceUrl,
      };
    });

    // Deduplicate
    const dedup = this.deduplicator.deduplicate(candidates);

    const jobsById = new Map(candidates.map((candidate, index) => [candidate.id, allJobs[index]]));

    // Map back to enriched jobs
    const enrichedJobs = dedup.groups.flatMap(group => {
      const original = jobsById.get(group.canonical.id);
      if (!original) {
        errors.push({ source: group.canonical.source, error: `Unable to map deduplicated job ${group.canonical.id}` });
        return [];
      }

      const fingerprint = this.deduplicator.generateFingerprint(
        group.canonical.title,
        group.canonical.company,
        group.canonical.description
      );

      return {
        ...original,
        id: group.canonical.id,
        fingerprint,
        duplicateGroupId: group.groupId,
        duplicateCount: 1 + group.duplicates.length,
      };
    });

    return {
      runId,
      totalDiscovered: allJobs.length,
      afterDeduplication: enrichedJobs.length,
      duplicatesRemoved: allJobs.length - enrichedJobs.length,
      jobs: enrichedJobs,
      errors,
      duration: Date.now() - startTime,
    };
  }
}
