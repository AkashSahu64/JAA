import { describe, expect, it } from 'vitest';
import { ClaimSourceFact, GeneratedResumeClaim, verifyResumeClaims } from './claim-verifier';

const approvedFacts: ClaimSourceFact[] = [
  {
    id: 'fact-experience',
    factType: 'EXPERIENCE',
    value: { text: 'Platform Engineer at Example Company from 2021 to 2025' },
    sourceText: 'Platform Engineer — Example Company — 2021–2025',
    checksum: 'experience-checksum',
    approved: true,
  },
  {
    id: 'fact-metric',
    factType: 'EXPERIENCE',
    value: { text: 'Reduced recovery time by 25%' },
    sourceText: 'Reduced recovery time by 25%',
    checksum: 'metric-checksum',
    approved: true,
  },
  {
    id: 'fact-skill',
    factType: 'SKILL',
    value: { text: 'TypeScript' },
    sourceText: 'TypeScript',
    checksum: 'skill-checksum',
    approved: true,
  },
  {
    id: 'fact-credential',
    factType: 'CERTIFICATION',
    value: { text: 'Example Cloud Associate, Example Institute, 2024' },
    sourceText: 'Example Cloud Associate — Example Institute — 2024',
    checksum: 'credential-checksum',
    approved: true,
  },
  {
    id: 'fact-pending',
    factType: 'SKILL',
    value: { text: 'Rust' },
    sourceText: 'Rust',
    checksum: 'pending-checksum',
    approved: false,
  },
];

function claim(id: string, text: string, sourceFactId?: string): GeneratedResumeClaim {
  return { id, section: 'Experience', claim: text, sourceFactId };
}

describe('verifyResumeClaims', () => {
  it('accepts only cited approved facts and emits deterministic durable provenance', () => {
    const claims = [
      claim('claim-company', 'Platform Engineer at Example Company from 2021 to 2025', 'fact-experience'),
      claim('claim-skill', 'typescript', 'fact-skill'),
    ];
    const result = verifyResumeClaims(claims, approvedFacts);

    expect(result.valid).toBe(true);
    expect(result.accepted).toEqual(claims);
    expect(result.rejected).toEqual([]);
    expect(result.provenance).toEqual([
      expect.objectContaining({
        schemaVersion: 1,
        verifier: 'resume-claim-verifier/v1',
        claimId: 'claim-company',
        sourceFactId: 'fact-experience',
        sourceChecksum: 'experience-checksum',
        verified: true,
      }),
      expect.objectContaining({ claimId: 'claim-skill', sourceFactId: 'fact-skill' }),
    ]);
    expect(result.provenance[0].provenanceId).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyResumeClaims(claims, approvedFacts)).toEqual(result);
  });

  it('rejects absent, unknown, and pending citations without provenance', () => {
    const result = verifyResumeClaims([
      claim('absent', 'TypeScript'),
      claim('unknown', 'TypeScript', 'fact-does-not-exist'),
      claim('pending', 'Rust', 'fact-pending'),
    ], approvedFacts);

    expect(result.valid).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.provenance).toEqual([]);
    expect(result.rejected.map(({ claimId, reason }) => ({ claimId, reason }))).toEqual([
      { claimId: 'absent', reason: 'ABSENT_CITATION' },
      { claimId: 'unknown', reason: 'CITATION_NOT_FOUND' },
      { claimId: 'pending', reason: 'CITATION_PENDING' },
    ]);
  });

  it.each([
    ['date', claim('date', 'Platform Engineer at Example Company from 2020 to 2025', 'fact-experience'), 'ALTERED_DATE'],
    ['company', claim('company', 'Platform Engineer at Evil Corp from 2021 to 2025', 'fact-experience'), 'ALTERED_COMPANY'],
    ['credential', claim('credential', 'Example Cloud Professional, Example Institute, 2024', 'fact-credential'), 'ALTERED_CREDENTIAL'],
    ['metric', claim('metric', 'Reduced recovery time by 75%', 'fact-metric'), 'ALTERED_METRIC'],
    ['skill', claim('skill', 'TypeScript and Rust', 'fact-skill'), 'ALTERED_SKILL'],
  ] as const)('rejects an altered %s claim', (_name, generated, reason) => {
    const result = verifyResumeClaims([generated], approvedFacts);
    expect(result.rejected).toEqual([expect.objectContaining({ claimId: generated.id, reason })]);
    expect(result.provenance).toEqual([]);
  });

  it('does not accept a claim because its text appears in an unrelated fact', () => {
    const result = verifyResumeClaims([
      claim('citation-swap', 'TypeScript', 'fact-metric'),
    ], approvedFacts);
    expect(result.rejected).toEqual([
      expect.objectContaining({ claimId: 'citation-swap', reason: 'CLAIM_NOT_SUPPORTED' }),
    ]);
  });

  it('rejects malformed and duplicate claim identifiers deterministically', () => {
    const result = verifyResumeClaims([
      claim('same', 'TypeScript', 'fact-skill'),
      claim('same', 'TypeScript', 'fact-skill'),
      { id: 'blank', section: 'Skills', claim: '   ', sourceFactId: 'fact-skill' },
    ], approvedFacts);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected.map((item) => item.reason)).toEqual(['DUPLICATE_CLAIM_ID', 'INVALID_CLAIM']);
  });
});
