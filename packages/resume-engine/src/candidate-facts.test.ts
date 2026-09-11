import { describe, expect, it } from 'vitest';
import { extractCandidateFacts, normalizeCandidateClaim } from './candidate-facts';

const fixture = `Jordan Example
jordan@example.invalid | +1 (555) 010-1234 | https://portfolio.example.invalid

SUMMARY
Backend engineer focused on reliable systems.

EXPERIENCE
Platform Engineer — Example Company — 2021–2025
Reduced deployment recovery time through tested runbooks.

SKILLS
TypeScript, PostgreSQL; Redis • Playwright

EDUCATION
B.S. Computer Science — Example University
`;

describe('candidate fact extraction', () => {
  it('extracts deterministic facts with exact source ranges', () => {
    const facts = extractCandidateFacts(fixture);
    expect(facts).toEqual(expect.arrayContaining([
      expect.objectContaining({ factType: 'EMAIL', sourceText: 'jordan@example.invalid' }),
      expect.objectContaining({ factType: 'SKILL', sourceText: 'TypeScript' }),
      expect.objectContaining({ factType: 'EXPERIENCE', sourceText: 'Reduced deployment recovery time through tested runbooks.' }),
    ]));
    for (const fact of facts) {
      expect(fixture.slice(fact.sourceStart, fact.sourceEnd)).toBe(fact.sourceText);
      expect(fact.checksum).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(extractCandidateFacts(fixture)).toEqual(facts);
  });

  it('does not infer claims absent from the source', () => {
    const facts = extractCandidateFacts('SKILLS\nTypeScript');
    expect(facts.map((fact) => fact.sourceText)).toEqual(['TypeScript']);
    expect(facts.some((fact) => JSON.stringify(fact.value).includes('JavaScript'))).toBe(false);
  });

  it('normalizes only presentation differences for claim comparison', () => {
    expect(normalizeCandidateClaim('  TypeScript\nServices ')).toBe('typescript services');
  });
});
