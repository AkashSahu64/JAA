import { randomUUID } from 'node:crypto';

export interface ResumeVersionRecord {
  id: string;
  resumeId: string;
  jobId?: string;
  company?: string;
  role?: string;
  jdHash?: string;
  content: string;
  htmlContent?: string;
  atsScoreOverall?: number;
  atsScoreData?: Record<string, unknown>;
  keywordCoverage: number;
  changesFromMaster: string[];
  sourceFacts: Array<{
    section: string;
    claim: string;
    sourceField: string;
    sourceValue: string;
    verified: boolean;
  }>;
  generatedAt: string;
}

export class ResumeVersionManager {
  private versions: Map<string, ResumeVersionRecord[]> = new Map();

  createVersion(params: {
    resumeId: string;
    jobId?: string;
    company?: string;
    role?: string;
    jdHash?: string;
    content: string;
    htmlContent?: string;
    atsScoreOverall?: number;
    atsScoreData?: Record<string, unknown>;
    keywordCoverage: number;
    changesFromMaster: string[];
    sourceFacts: ResumeVersionRecord['sourceFacts'];
  }): ResumeVersionRecord {
    const version: ResumeVersionRecord = {
      id: randomUUID(),
      ...params,
      generatedAt: new Date().toISOString(),
    };

    const existing = this.versions.get(params.resumeId) || [];
    existing.push(version);
    this.versions.set(params.resumeId, existing);

    return version;
  }

  getVersions(resumeId: string): ResumeVersionRecord[] {
    return [...(this.versions.get(resumeId) || [])];
  }

  getVersion(versionId: string): ResumeVersionRecord | undefined {
    for (const versions of this.versions.values()) {
      const found = versions.find(v => v.id === versionId);
      if (found) return found;
    }
    return undefined;
  }

  getVersionForJob(resumeId: string, jobId: string): ResumeVersionRecord | undefined {
    const versions = this.versions.get(resumeId) || [];
    return versions.find(v => v.jobId === jobId);
  }

  compareVersions(
    versionA: ResumeVersionRecord,
    versionB: ResumeVersionRecord
  ): {
    addedLines: string[];
    removedLines: string[];
    changesCount: number;
  } {
    const linesA = versionA.content.split('\n');
    const linesB = versionB.content.split('\n');

    const setA = new Set(linesA);
    const setB = new Set(linesB);

    const addedLines = linesB.filter(l => !setA.has(l) && l.trim());
    const removedLines = linesA.filter(l => !setB.has(l) && l.trim());

    return {
      addedLines,
      removedLines,
      changesCount: addedLines.length + removedLines.length,
    };
  }
}
