import { describe, expect, it } from 'vitest';
import { APPLICATION_QUALITY_VERSION, evaluateApplicationQuality, type ApplicationQualityInput } from './application-quality';

function input(overrides: Partial<ApplicationQualityInput> = {}): ApplicationQualityInput {
  return {
    job: { active: true, company: 'Example', title: 'Platform Engineer', source: 'greenhouse' },
    profile: { targetRoles: ['Platform Engineer'], excludedCompanies: [], sources: ['greenhouse'], minMatchScore: 80, minATSScore: 85, maxApplicationsPerDay: 10 },
    scores: { match: 90, ats: 90 },
    truth: { verifiedClaimCount: 2, valid: true },
    artifact: { contentReady: true, atsEvidenceReady: true },
    dailyCapacity: { reserved: 0, available: true },
    rules: [],
    ...overrides,
  };
}

describe('application quality gate', () => {
  it('passes only when all mandatory evidence and policy checks pass', () => {
    expect(evaluateApplicationQuality(input())).toMatchObject({
      version: APPLICATION_QUALITY_VERSION,
      decision: 'PASS',
      context: { matchScore: 90, atsScore: 90, dailyReserved: 0, dailyLimit: 10 },
    });
  });

  it('fails closed when required evidence or truthful provenance is absent', () => {
    const result = evaluateApplicationQuality(input({
      scores: { match: null, ats: null },
      truth: { valid: false, verifiedClaimCount: 0 },
      artifact: { contentReady: false, atsEvidenceReady: false },
    }));
    expect(result.decision).toBe('FAIL');
    expect(result.rules.filter(rule => rule.status === 'FAIL').map(rule => rule.code)).toEqual(expect.arrayContaining([
      'RESUME_CONTENT_READY', 'ATS_EVIDENCE_READY', 'TRUTH_PROVENANCE', 'MATCH_SCORE_AVAILABLE', 'ATS_SCORE_AVAILABLE',
    ]));
  });

  it('skips jobs that violate preferences, thresholds, user rules, or daily budget', () => {
    const result = evaluateApplicationQuality(input({
      job: { active: true, company: 'Blocked Corp', title: 'Other Role', source: 'lever' },
      profile: { ...input().profile, excludedCompanies: ['blocked corp'], sources: ['greenhouse'], minMatchScore: 95, minATSScore: 95 },
      scores: { match: 90, ats: 90 },
      dailyCapacity: { reserved: 10, available: false },
      rules: [{ id: 'skip-rule', name: 'Skip low match', enabled: true, conditions: [{ field: 'matchScore', operator: 'lte', value: 90 }], action: 'SKIP', priority: 1 }],
    }));
    expect(result.decision).toBe('SKIPPED');
    expect(result.rules.filter(rule => rule.status === 'SKIPPED').map(rule => rule.code)).toEqual(expect.arrayContaining([
      'MATCH_THRESHOLD', 'ATS_THRESHOLD', 'COMPANY_EXCLUDED', 'SOURCE_PREFERENCE', 'ROLE_PREFERENCE', 'USER_RULE', 'DAILY_CAPACITY',
    ]));
  });

  it('evaluates tied user rules deterministically by rule identifier', () => {
    const result = evaluateApplicationQuality(input({ rules: [
      { id: 'z-rule', name: 'Later', enabled: true, conditions: [], action: 'SKIP', priority: 5 },
      { id: 'a-rule', name: 'Earlier', enabled: true, conditions: [], action: 'REVIEW', priority: 5 },
    ] }));
    expect(result.rules.find(rule => rule.code === 'USER_RULE')).toMatchObject({ message: 'Matched user rule: Earlier' });
    expect(result.decision).toBe('PASS');
  });
});
