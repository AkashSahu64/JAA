import { createHash, randomUUID } from 'node:crypto';

export interface DeduplicationCandidate {
  id: string;
  source: string;
  sourceJobId?: string;
  company: string;
  title: string;
  normalizedTitle?: string;
  location?: string;
  description: string;
  applicationUrl: string;
  sourceUrl: string;
}

export interface DeduplicationResult {
  groups: DeduplicationGroup[];
  totalOriginal: number;
  totalDeduplicated: number;
  duplicatesFound: number;
}

export interface DeduplicationGroup {
  groupId: string;
  canonical: DeduplicationCandidate;
  duplicates: DeduplicationCandidate[];
  confidence: number;
}

export class DeduplicationEngine {
  private similarityThreshold = 0.75;

  deduplicate(jobs: DeduplicationCandidate[]): DeduplicationResult {
    const groups: DeduplicationGroup[] = [];
    const processed = new Set<string>();

    for (const job of jobs) {
      if (processed.has(job.id)) continue;

      const group: DeduplicationGroup = {
        groupId: randomUUID(),
        canonical: job,
        duplicates: [],
        confidence: 1,
      };

      for (const other of jobs) {
        if (other.id === job.id || processed.has(other.id)) continue;

        const similarity = this.calculateSimilarity(job, other);
        if (similarity >= this.similarityThreshold) {
          group.duplicates.push(other);
          group.confidence = Math.min(group.confidence, similarity);
          processed.add(other.id);
        }
      }

      processed.add(job.id);
      groups.push(group);
    }

    return {
      groups,
      totalOriginal: jobs.length,
      totalDeduplicated: groups.length,
      duplicatesFound: jobs.length - groups.length,
    };
  }

  calculateSimilarity(a: DeduplicationCandidate, b: DeduplicationCandidate): number {
    let score = 0;
    let weights = 0;

    // Source Job ID match (strongest signal)
    if (a.sourceJobId && b.sourceJobId && a.sourceJobId === b.sourceJobId && a.source === b.source) {
      return 1.0;
    }

    // Canonical URL match
    if (this.normalizeUrl(a.applicationUrl) === this.normalizeUrl(b.applicationUrl)) {
      return 0.98;
    }

    // Company match
    const companyMatch = this.normalizeCompanyName(a.company) === this.normalizeCompanyName(b.company);
    if (companyMatch) {
      score += 0.3;
    }
    weights += 0.3;

    // Title match
    const titleSim = this.stringSimilarity(
      this.normalizeJobTitle(a.title),
      this.normalizeJobTitle(b.title)
    );
    score += titleSim * 0.3;
    weights += 0.3;

    // Location match
    if (a.location && b.location) {
      const locSim = this.stringSimilarity(
        a.location.toLowerCase(),
        b.location.toLowerCase()
      );
      score += locSim * 0.1;
    }
    weights += 0.1;

    // Description similarity (using fingerprint)
    const descSim = this.descriptionSimilarity(a.description, b.description);
    score += descSim * 0.3;
    weights += 0.3;

    return score / weights;
  }

  generateFingerprint(title: string, company: string, description: string): string {
    const normalized = [
      this.normalizeJobTitle(title),
      this.normalizeCompanyName(company),
      this.normalizeDescription(description).slice(0, 500),
    ].join('|');

    return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  }

  private normalizeUrl(url: string): string {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }

  private normalizeJobTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeCompanyName(company: string): string {
    return company
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+(inc|llc|ltd|corp|co|company|technologies|tech|solutions|software|services)$/g, '')
      .trim();
  }

  private normalizeDescription(desc: string): string {
    return desc
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const wordsA = new Set(a.split(' '));
    const wordsB = new Set(b.split(' '));
    
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    
    return intersection.size / union.size; // Jaccard similarity
  }

  private descriptionSimilarity(a: string, b: string): number {
    const normA = this.normalizeDescription(a);
    const normB = this.normalizeDescription(b);
    
    // Use shingle-based similarity (3-grams)
    const shinglesA = this.getShingles(normA, 3);
    const shinglesB = this.getShingles(normB, 3);
    
    if (shinglesA.size === 0 || shinglesB.size === 0) return 0;
    
    const intersection = new Set([...shinglesA].filter(x => shinglesB.has(x)));
    const union = new Set([...shinglesA, ...shinglesB]);
    
    return intersection.size / union.size;
  }

  private getShingles(text: string, n: number): Set<string> {
    const words = text.split(' ');
    const shingles = new Set<string>();
    for (let i = 0; i <= words.length - n; i++) {
      shingles.add(words.slice(i, i + n).join(' '));
    }
    return shingles;
  }
}
