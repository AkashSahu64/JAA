import { describe, expect, it } from 'vitest';
import { calculateDeterministicATSScore } from './ats';

const job = {
  title: 'Platform Engineer',
  description: 'Build TypeScript services with PostgreSQL and Kubernetes. Improve reliability and observability.',
  requiredSkills: ['TypeScript', 'PostgreSQL', 'Kubernetes'],
  mustHave: ['Observability'],
};

const resume = `Jordan Example
jordan@example.invalid | +1 (555) 010-1234

EXPERIENCE
Platform Engineer
• Built TypeScript services with PostgreSQL and improved reliability by 25%.

EDUCATION
B.S. Computer Science

SKILLS
TypeScript, PostgreSQL, Observability`;

describe('deterministic ATS scoring', () => {
  it('returns an exactly repeatable bounded score with evidence', () => {
    const first = calculateDeterministicATSScore(resume, job);
    const second = calculateDeterministicATSScore(resume, job);
    expect(first).toEqual(second);
    expect(first.overall).toBeGreaterThanOrEqual(0);
    expect(first.overall).toBeLessThanOrEqual(100);
    expect(first.evidence.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.evidence.matchedRequiredSkills).toEqual(['TypeScript', 'PostgreSQL', 'Observability']);
    expect(first.evidence.missingRequiredSkills).toEqual(['Kubernetes']);
    expect(first.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'MISSING_REQUIRED_SKILLS' }),
    ]));
  });

  it('detects deterministic parser, formatting, contact, and stuffing risks', () => {
    const result = calculateDeterministicATSScore('SKILLS\nTypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript TypeScript\t|', job);
    expect(result.issues.map((item) => item.type)).toEqual(expect.arrayContaining([
      'CONTACT_INFO', 'FORMAT_RISK', 'MISSING_SECTIONS', 'KEYWORD_STUFFING',
    ]));
    expect(result.formattingCompatibility).toBeLessThan(100);
    expect(result.readabilityScore).toBeLessThan(100);
  });

  it('does not infer absent requirements and keeps empty required skills fully covered', () => {
    const result = calculateDeterministicATSScore(resume, { title: 'Platform Engineer', description: '', requiredSkills: [] });
    expect(result.requiredSkillCoverage).toBe(100);
    expect(result.evidence.missingRequiredSkills).toEqual([]);
  });
});
