import { createHash } from 'node:crypto';
import { normalizeCandidateClaim } from './candidate-facts';

export interface ClaimSourceFact {
  id: string;
  factType: string;
  value: Record<string, unknown>;
  sourceText: string;
  checksum: string;
  approved: boolean;
}

export interface GeneratedResumeClaim {
  id: string;
  section: string;
  claim: string;
  sourceFactId?: string | null;
}

export type ClaimRejectionReason =
  | 'INVALID_CLAIM'
  | 'DUPLICATE_CLAIM_ID'
  | 'ABSENT_CITATION'
  | 'CITATION_NOT_FOUND'
  | 'CITATION_PENDING'
  | 'ALTERED_DATE'
  | 'ALTERED_COMPANY'
  | 'ALTERED_CREDENTIAL'
  | 'ALTERED_METRIC'
  | 'ALTERED_SKILL'
  | 'CLAIM_NOT_SUPPORTED';

export interface RejectedResumeClaim {
  claimId: string;
  claim: string;
  reason: ClaimRejectionReason;
  sourceFactId?: string;
}

export interface VerifiedClaimProvenance {
  schemaVersion: 1;
  verifier: 'resume-claim-verifier/v1';
  provenanceId: string;
  claimId: string;
  section: string;
  claim: string;
  normalizedClaim: string;
  sourceFactId: string;
  sourceFactType: string;
  sourceText: string;
  sourceChecksum: string;
  verified: true;
}

export interface ClaimVerificationResult {
  valid: boolean;
  accepted: GeneratedResumeClaim[];
  rejected: RejectedResumeClaim[];
  provenance: VerifiedClaimProvenance[];
}

const DATE_PATTERN = /\b(?:19|20)\d{2}\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const METRIC_PATTERN = /(?:[$€£]\s*\d[\d,.]*|\d[\d,.]*\s*(?:%|x\b|percent\b|milliseconds?\b|seconds?\b|minutes?\b|hours?\b|days?\b|users?\b|customers?\b|requests?\b))/gi;

function factText(fact: ClaimSourceFact): string {
  const text = fact.value.text;
  return typeof text === 'string' && text.trim() ? text : fact.sourceText;
}

function normalizeComparable(value: string): string {
  return normalizeCandidateClaim(value)
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[^\p{L}\p{N}%$€£+.#/-]+/gu, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalizeComparable(value).match(/[\p{L}\p{N}+#.%$€£/-]+/gu) ?? [];
}

function extracted(pattern: RegExp, value: string): string[] {
  return [...value.matchAll(pattern)].map((match) => normalizeComparable(match[0]));
}

function tokenSubsequence(claim: string, source: string): boolean {
  const claimTokens = tokens(claim);
  const sourceTokens = tokens(source);
  if (claimTokens.length === 0 || claimTokens.length > sourceTokens.length) return false;
  let position = 0;
  for (const token of sourceTokens) {
    if (token === claimTokens[position]) position += 1;
    if (position === claimTokens.length) return true;
  }
  return false;
}

function unsupportedSpecificReason(claim: string, source: string, factType: string): ClaimRejectionReason | null {
  const normalizedType = factType.toLocaleUpperCase('en-US');
  const claimDates = extracted(DATE_PATTERN, claim);
  const sourceDates = new Set(extracted(DATE_PATTERN, source));
  if (claimDates.some((value) => !sourceDates.has(value))) return 'ALTERED_DATE';

  const claimMetrics = extracted(METRIC_PATTERN, claim);
  const sourceMetrics = new Set(extracted(METRIC_PATTERN, source));
  if (claimMetrics.some((value) => !sourceMetrics.has(value))) return 'ALTERED_METRIC';

  if (normalizedType === 'SKILL' && normalizeComparable(claim) !== normalizeComparable(source)) return 'ALTERED_SKILL';
  if ((normalizedType === 'CERTIFICATION' || normalizedType === 'CREDENTIAL') && !tokenSubsequence(claim, source)) {
    return 'ALTERED_CREDENTIAL';
  }
  if (normalizedType === 'COMPANY' && !tokenSubsequence(claim, source)) return 'ALTERED_COMPANY';
  if (normalizedType === 'EXPERIENCE' && !tokenSubsequence(claim, source)) {
    const sourceTokens = new Set(tokens(source));
    const companyIndicators = tokens(claim).filter((token) => /corp(?:oration)?|company|inc|llc|ltd|group|systems|technologies/.test(token));
    if (companyIndicators.some((token) => !sourceTokens.has(token))) return 'ALTERED_COMPANY';
  }
  return null;
}

function supportsClaim(claim: string, source: string): boolean {
  const normalizedClaim = normalizeComparable(claim);
  const normalizedSource = normalizeComparable(source);
  return normalizedClaim === normalizedSource || tokenSubsequence(claim, source);
}

function provenance(claim: GeneratedResumeClaim, fact: ClaimSourceFact): VerifiedClaimProvenance {
  const normalizedClaim = normalizeComparable(claim.claim);
  const provenanceId = createHash('sha256')
    .update(JSON.stringify({ claimId: claim.id, normalizedClaim, sourceFactId: fact.id, sourceChecksum: fact.checksum }))
    .digest('hex');
  return {
    schemaVersion: 1,
    verifier: 'resume-claim-verifier/v1',
    provenanceId,
    claimId: claim.id,
    section: claim.section.trim(),
    claim: claim.claim.trim(),
    normalizedClaim,
    sourceFactId: fact.id,
    sourceFactType: fact.factType,
    sourceText: fact.sourceText,
    sourceChecksum: fact.checksum,
    verified: true,
  };
}

export function verifyResumeClaims(
  claims: readonly GeneratedResumeClaim[],
  sourceFacts: readonly ClaimSourceFact[],
): ClaimVerificationResult {
  const factsById = new Map(sourceFacts.map((fact) => [fact.id, fact]));
  const seenClaimIds = new Set<string>();
  const accepted: GeneratedResumeClaim[] = [];
  const rejected: RejectedResumeClaim[] = [];
  const records: VerifiedClaimProvenance[] = [];

  for (const claim of claims) {
    const citation = claim.sourceFactId?.trim();
    const reject = (reason: ClaimRejectionReason): void => {
      rejected.push({ claimId: claim.id, claim: claim.claim, reason, ...(citation ? { sourceFactId: citation } : {}) });
    };

    if (!claim.id.trim() || !claim.section.trim() || !claim.claim.trim()) {
      reject('INVALID_CLAIM');
      continue;
    }
    if (seenClaimIds.has(claim.id)) {
      reject('DUPLICATE_CLAIM_ID');
      continue;
    }
    seenClaimIds.add(claim.id);
    if (!citation) {
      reject('ABSENT_CITATION');
      continue;
    }
    const fact = factsById.get(citation);
    if (!fact) {
      reject('CITATION_NOT_FOUND');
      continue;
    }
    if (!fact.approved) {
      reject('CITATION_PENDING');
      continue;
    }

    const source = factText(fact);
    const specificReason = unsupportedSpecificReason(claim.claim, source, fact.factType);
    if (specificReason) {
      reject(specificReason);
      continue;
    }
    if (!supportsClaim(claim.claim, source)) {
      reject('CLAIM_NOT_SUPPORTED');
      continue;
    }

    accepted.push(claim);
    records.push(provenance(claim, fact));
  }

  return { valid: rejected.length === 0, accepted, rejected, provenance: records };
}
