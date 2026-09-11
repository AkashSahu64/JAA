export const APPLICATION_QUALITY_VERSION = 'application-quality/1.0.0' as const;

export type ApplicationQualityDecision = 'PASS' | 'FAIL' | 'SKIPPED';
export type QualityRuleStatus = 'PASS' | 'FAIL' | 'SKIPPED' | 'INFO';

export interface QualityRuleEvidence {
  code: string;
  status: QualityRuleStatus;
  message: string;
  details?: Record<string, boolean | number | string | string[]>;
}

export interface QualityRuleCondition {
  field: string;
  operator: 'gte' | 'lte' | 'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'not_in';
  value: string | number | boolean | string[];
}

export interface QualityUserRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: QualityRuleCondition[];
  action: string;
  priority: number;
}

export interface ApplicationQualityInput {
  job: { active: boolean; company: string; title: string; source: string };
  profile: {
    targetRoles: string[];
    excludedCompanies: string[];
    sources: string[];
    minMatchScore: number;
    minATSScore: number;
    maxApplicationsPerDay: number;
  };
  scores: { match: number | null; ats: number | null };
  truth: { verifiedClaimCount: number; valid: boolean };
  artifact: { contentReady: boolean; atsEvidenceReady: boolean };
  dailyCapacity: { reserved: number; available: boolean };
  rules: QualityUserRule[];
}

export interface ApplicationQualityResult {
  version: typeof APPLICATION_QUALITY_VERSION;
  decision: ApplicationQualityDecision;
  rules: QualityRuleEvidence[];
  context: {
    matchScore: number | null;
    atsScore: number | null;
    dailyReserved: number;
    dailyLimit: number;
  };
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function includes(values: string[], value: string): boolean {
  const target = normalized(value);
  return values.some(item => normalized(item) === target);
}

function ruleContext(input: ApplicationQualityInput): Record<string, string | number | boolean> {
  return {
    matchScore: input.scores.match ?? -1,
    atsScore: input.scores.ats ?? -1,
    jobTitle: input.job.title,
    company: input.job.company,
    source: input.job.source,
    isActive: input.job.active,
    dailyReserved: input.dailyCapacity.reserved,
    dailyLimit: input.profile.maxApplicationsPerDay,
    verifiedClaimCount: input.truth.verifiedClaimCount,
  };
}

function conditionMatches(condition: QualityRuleCondition, context: Record<string, string | number | boolean>): boolean {
  const actual = context[condition.field];
  if (actual === undefined) return false;
  switch (condition.operator) {
    case 'gte': return Number(actual) >= Number(condition.value);
    case 'lte': return Number(actual) <= Number(condition.value);
    case 'eq': return actual === condition.value;
    case 'neq': return actual !== condition.value;
    case 'contains': return String(actual).toLocaleLowerCase('en-US').includes(String(condition.value).toLocaleLowerCase('en-US'));
    case 'not_contains': return !String(actual).toLocaleLowerCase('en-US').includes(String(condition.value).toLocaleLowerCase('en-US'));
    case 'in': return Array.isArray(condition.value) && condition.value.includes(String(actual));
    case 'not_in': return Array.isArray(condition.value) && !condition.value.includes(String(actual));
  }
}

function matchedRule(input: ApplicationQualityInput): QualityUserRule | null {
  const context = ruleContext(input);
  const sorted = [...input.rules].filter(rule => rule.enabled)
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
  return sorted.find(rule => rule.conditions.every(condition => conditionMatches(condition, context))) ?? null;
}

function failed(rules: QualityRuleEvidence[]): boolean {
  return rules.some(rule => rule.status === 'FAIL');
}

function skipped(rules: QualityRuleEvidence[]): boolean {
  return rules.some(rule => rule.status === 'SKIPPED');
}

export function evaluateApplicationQuality(input: ApplicationQualityInput): ApplicationQualityResult {
  const rules: QualityRuleEvidence[] = [];
  rules.push(input.job.active
    ? { code: 'JOB_ACTIVE', status: 'PASS', message: 'Job is active' }
    : { code: 'JOB_ACTIVE', status: 'FAIL', message: 'Job is inactive' });
  rules.push(input.artifact.contentReady
    ? { code: 'RESUME_CONTENT_READY', status: 'PASS', message: 'Resume content is present' }
    : { code: 'RESUME_CONTENT_READY', status: 'FAIL', message: 'Resume content is missing' });
  rules.push(input.artifact.atsEvidenceReady
    ? { code: 'ATS_EVIDENCE_READY', status: 'PASS', message: 'Deterministic ATS evidence is present' }
    : { code: 'ATS_EVIDENCE_READY', status: 'FAIL', message: 'Deterministic ATS evidence is missing' });
  rules.push(input.truth.valid && input.truth.verifiedClaimCount > 0
    ? { code: 'TRUTH_PROVENANCE', status: 'PASS', message: 'Resume claims have verified provenance', details: { verifiedClaimCount: input.truth.verifiedClaimCount } }
    : { code: 'TRUTH_PROVENANCE', status: 'FAIL', message: 'Resume claims lack verified provenance', details: { verifiedClaimCount: input.truth.verifiedClaimCount } });
  rules.push(input.scores.match !== null
    ? { code: 'MATCH_SCORE_AVAILABLE', status: 'PASS', message: 'Deterministic match score is present', details: { matchScore: input.scores.match } }
    : { code: 'MATCH_SCORE_AVAILABLE', status: 'FAIL', message: 'Deterministic match score is missing' });
  rules.push(input.scores.ats !== null
    ? { code: 'ATS_SCORE_AVAILABLE', status: 'PASS', message: 'Deterministic ATS score is present', details: { atsScore: input.scores.ats } }
    : { code: 'ATS_SCORE_AVAILABLE', status: 'FAIL', message: 'Deterministic ATS score is missing' });

  if (input.scores.match !== null && input.scores.match < input.profile.minMatchScore) {
    rules.push({ code: 'MATCH_THRESHOLD', status: 'SKIPPED', message: 'Match score is below the search profile threshold', details: { actual: input.scores.match, required: input.profile.minMatchScore } });
  }
  if (input.scores.ats !== null && input.scores.ats < input.profile.minATSScore) {
    rules.push({ code: 'ATS_THRESHOLD', status: 'SKIPPED', message: 'ATS score is below the search profile threshold', details: { actual: input.scores.ats, required: input.profile.minATSScore } });
  }
  if (includes(input.profile.excludedCompanies, input.job.company)) {
    rules.push({ code: 'COMPANY_EXCLUDED', status: 'SKIPPED', message: 'Company is excluded by the search profile', details: { company: input.job.company } });
  }
  if (input.profile.sources.length > 0 && !includes(input.profile.sources, input.job.source)) {
    rules.push({ code: 'SOURCE_PREFERENCE', status: 'SKIPPED', message: 'Job source is outside the search profile', details: { source: input.job.source } });
  }
  if (input.profile.targetRoles.length > 0 && !includes(input.profile.targetRoles, input.job.title)) {
    rules.push({ code: 'ROLE_PREFERENCE', status: 'SKIPPED', message: 'Job title is outside the search profile', details: { title: input.job.title } });
  }

  const matched = matchedRule(input);
  if (matched) {
    rules.push({ code: 'USER_RULE', status: matched.action === 'SKIP' ? 'SKIPPED' : 'INFO', message: `Matched user rule: ${matched.name}`, details: { ruleId: matched.id, action: matched.action } });
  }
  if (!input.dailyCapacity.available) {
    rules.push({ code: 'DAILY_CAPACITY', status: 'SKIPPED', message: 'Daily application limit is exhausted', details: { reserved: input.dailyCapacity.reserved, limit: input.profile.maxApplicationsPerDay } });
  }

  return {
    version: APPLICATION_QUALITY_VERSION,
    decision: failed(rules) ? 'FAIL' : skipped(rules) ? 'SKIPPED' : 'PASS',
    rules,
    context: { matchScore: input.scores.match, atsScore: input.scores.ats, dailyReserved: input.dailyCapacity.reserved, dailyLimit: input.profile.maxApplicationsPerDay },
  };
}
