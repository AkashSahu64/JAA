import { Prisma, ResumeSourceFact } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { extractCandidateFacts, normalizeCandidateClaim } from '@jobagent/resume-engine';

export type CandidateFactDecision = 'APPROVE' | 'REJECT';

export class CandidateFactError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'UNSUPPORTED' | 'CONFLICT', message: string) {
    super(message);
    this.name = 'CandidateFactError';
  }
}

export async function replaceResumeCandidateFacts(resumeId: string, userId: string): Promise<ResumeSourceFact[]> {
  if (!resumeId.trim() || !userId.trim()) throw new CandidateFactError('INVALID', 'Resume and user identifiers are required');
  return withTenant(userId, async (tx) => {
    const resume = await tx.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true, content: true } });
    if (!resume) throw new CandidateFactError('NOT_FOUND', 'Resume not found');
    const drafts = extractCandidateFacts(resume.content);
    await tx.resumeSourceFact.deleteMany({ where: { resumeId, userId, approved: false } });
    if (drafts.length === 0) return [];
    await tx.resumeSourceFact.createMany({
      data: drafts.map((fact) => ({ ...fact, resumeId, userId, value: fact.value as Prisma.InputJsonValue })),
      skipDuplicates: true,
    });
    return tx.resumeSourceFact.findMany({ where: { resumeId, userId }, orderBy: [{ sourceStart: 'asc' }, { createdAt: 'asc' }] });
  });
}

export async function listResumeCandidateFacts(resumeId: string, userId: string): Promise<ResumeSourceFact[]> {
  return withTenant(userId, (tx) => tx.resumeSourceFact.findMany({
    where: { resumeId, userId, resume: { userId } },
    orderBy: [{ sourceStart: 'asc' }, { createdAt: 'asc' }],
  }));
}

export async function decideResumeCandidateFact(input: {
  resumeId: string;
  factId: string;
  userId: string;
  decision: CandidateFactDecision;
}): Promise<ResumeSourceFact | null> {
  return withTenant(input.userId, async (tx) => {
    const fact = await tx.resumeSourceFact.findFirst({
      where: { id: input.factId, resumeId: input.resumeId, userId: input.userId, resume: { userId: input.userId } },
    });
    if (!fact) throw new CandidateFactError('NOT_FOUND', 'Candidate fact not found');
    if (input.decision === 'REJECT') {
      if (fact.approved) throw new CandidateFactError('CONFLICT', 'Approved facts cannot be rejected without a new resume revision');
      await tx.resumeSourceFact.delete({ where: { id: fact.id } });
      await tx.auditLog.create({
        data: {
          userId: input.userId,
          action: 'CANDIDATE_FACT_REJECTED',
          resource: 'ResumeSourceFact',
          resourceId: fact.id,
          details: { resumeId: input.resumeId, checksum: fact.checksum },
        },
      });
      return null;
    }
    if (fact.approved) return fact;
    const approved = await tx.resumeSourceFact.update({
      where: { id: fact.id },
      data: { approved: true, approvedAt: new Date(), approvedBy: input.userId },
    });
    await tx.auditLog.create({
      data: {
        userId: input.userId,
        action: 'CANDIDATE_FACT_APPROVED',
        resource: 'ResumeSourceFact',
        resourceId: fact.id,
        details: { resumeId: input.resumeId, checksum: fact.checksum },
      },
    });
    return approved;
  });
}

function factText(fact: Pick<ResumeSourceFact, 'value' | 'sourceText'>): string {
  if (fact.value && typeof fact.value === 'object' && !Array.isArray(fact.value)) {
    const text = (fact.value as Record<string, unknown>).text;
    if (typeof text === 'string') return text;
  }
  return fact.sourceText;
}

export async function requireApprovedCandidateClaims(userId: string, claims: string[]): Promise<ResumeSourceFact[]> {
  if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== 'string' || !claim.trim())) {
    throw new CandidateFactError('INVALID', 'Claims must be non-empty strings');
  }
  const approved = await withTenant(userId, (tx) => tx.resumeSourceFact.findMany({ where: { userId, approved: true } }));
  const byClaim = new Map(approved.map((fact) => [normalizeCandidateClaim(factText(fact)), fact]));
  const unsupported = claims.filter((claim) => !byClaim.has(normalizeCandidateClaim(claim)));
  if (unsupported.length > 0) {
    throw new CandidateFactError('UNSUPPORTED', `Unsupported candidate claims: ${unsupported.join('; ')}`);
  }
  return claims.map((claim) => byClaim.get(normalizeCandidateClaim(claim))!);
}
