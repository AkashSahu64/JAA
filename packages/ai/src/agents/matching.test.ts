import { describe, expect, it } from 'vitest';
import { calculateDeterministicMatch, type JobForMatching, type ProfileForMatching } from './matching';

const profile: ProfileForMatching = {
  currentRole: 'Platform Engineer', yearsOfExperience: 6, targetRoles: ['Platform Engineer'], seniority: 'Senior',
  skills: { programming: ['TypeScript', 'SQL'], cloud: ['AWS'], databases: ['PostgreSQL'] },
  experience: [{ company: 'Example', position: 'Platform Engineer', technologies: ['TypeScript', 'PostgreSQL', 'AWS'], responsibilities: ['Own services'] }],
  education: [{ degree: 'Bachelor', field: 'Computer Science' }], certifications: [], locationCity: 'New York', locationCountry: 'US',
  remotePreference: ['remote'], salaryMax: 180000, workAuthorized: true, sponsorshipNeeded: false,
};
const job: JobForMatching = {
  title: 'Platform Engineer', company: 'Example', location: 'Remote', remoteType: 'Remote', requirements: ['Bachelor degree'],
  skills: ['TypeScript', 'PostgreSQL'], technologyStack: ['TypeScript', 'PostgreSQL', 'AWS'], seniority: 'Senior',
  experienceMin: 5, salaryMin: 150000, description: 'Build services.',
};

describe('deterministic job matching', () => {
  it('returns the same evidence-bound score for identical inputs', () => {
    expect(calculateDeterministicMatch(profile, job)).toEqual(calculateDeterministicMatch(profile, job));
  });

  it('makes required-skill and authorization gaps visible in dimensions and evidence lists', () => {
    const result = calculateDeterministicMatch({ ...profile, skills: { programming: ['JavaScript'] }, workAuthorized: false, sponsorshipNeeded: true }, { ...job, skills: ['TypeScript', 'Kubernetes'] });
    expect(result.skillMatch).toBeLessThan(100);
    expect(result.missingSkills).toContain('kubernetes');
    expect(result.workAuthorizationMatch).toBe(25);
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
  });

  it('uses neutral scores for missing non-required information instead of inventing a match', () => {
    const result = calculateDeterministicMatch(profile, { ...job, experienceMin: undefined, salaryMin: undefined, seniority: undefined, location: undefined, remoteType: undefined, skills: [], requirements: [], technologyStack: [] });
    expect(result.experienceMatch).toBe(50);
    expect(result.salaryMatch).toBe(50);
    expect(result.seniorityMatch).toBe(50);
  });
});
