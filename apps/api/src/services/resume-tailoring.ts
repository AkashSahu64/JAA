import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { ResumeTailoringAgent, type TailoringSourceFact } from '@jobagent/ai';
import { withTenant } from '@jobagent/database';
import { type ClaimSourceFact, verifyResumeClaims } from '@jobagent/resume-engine';

export class ResumeTailoringError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND' | 'NO_APPROVED_FACTS' | 'UNSUPPORTED_CLAIMS' | 'FACTS_CHANGED', message: string) {
    super(message);
    this.name = 'ResumeTailoringError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceFact(fact: ClaimSourceFact): TailoringSourceFact {
  return { id: fact.id, factType: fact.factType, sourceText: fact.sourceText, checksum: fact.checksum };
}

function asClaimSourceFact(fact: {
  id: string; factType: string; value: Prisma.JsonValue; sourceText: string; checksum: string; approved: boolean;
}): ClaimSourceFact {
  return { ...fact, value: fact.value as Record<string, unknown> };
}

function contentFromClaims(claims: Array<{ section: string; claim: string }>): string {
  const sections = new Map<string, string[]>();
  for (const claim of claims) {
    const entries = sections.get(claim.section) ?? [];
    entries.push(claim.claim);
    sections.set(claim.section, entries);
  }
  return [...sections].map(([section, entries]) => `${section.toUpperCase()}\n${entries.map((entry) => `• ${entry}`).join('\n')}`).join('\n\n');
}

function htmlFromContent(content: string): string {
  const escaped = content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Tailored resume</title></head><body><pre>${escaped}</pre></body></html>`;
}

export async function executeResumeTailoring(userId: string, resumeId: string, jobId: string, agent: Pick<ResumeTailoringAgent, 'tailor'> = new ResumeTailoringAgent()) {
  if (!userId.trim() || !resumeId.trim() || !jobId.trim()) throw new ResumeTailoringError('INVALID', 'User, resume, and job identifiers are required');
  const input = await withTenant(userId, async (tx) => {
    const [resume, job] = await Promise.all([
      tx.resume.findFirst({ where: { id: resumeId, userId }, select: { id: true } }),
      tx.job.findUnique({ where: { id: jobId, }, include: { analysis: { select: { mustHave: true, niceToHave: true } } } }),
    ]);
    if (!resume || !job) throw new ResumeTailoringError('NOT_FOUND', 'Resume or job not found');
    const facts = await tx.resumeSourceFact.findMany({ where: { resumeId, userId, approved: true }, orderBy: [{ sourceStart: 'asc' }, { id: 'asc' }] });
    if (facts.length === 0) throw new ResumeTailoringError('NO_APPROVED_FACTS', 'Approve candidate facts before tailoring a resume');
    return { job, facts: facts.map(asClaimSourceFact) };
  });

  const tailored = await agent.tailor({
    job: {
      title: input.job.title, company: input.job.company, description: input.job.description,
      requiredSkills: input.job.skills, mustHave: input.job.analysis?.mustHave ?? [], niceToHave: input.job.analysis?.niceToHave ?? [],
    },
    sourceFacts: input.facts.map(sourceFact),
  });
  const verification = verifyResumeClaims(tailored.claims, input.facts);
  if (!verification.valid) throw new ResumeTailoringError('UNSUPPORTED_CLAIMS', `Tailoring contained unsupported claims: ${verification.rejected.map((claim) => claim.reason).join(', ')}`);
  const content = contentFromClaims(verification.accepted);
  const provenance = verification.provenance as unknown as Prisma.InputJsonValue;

  return withTenant(userId, async (tx) => {
    const current = await tx.resumeSourceFact.findMany({ where: { resumeId, userId, approved: true, id: { in: verification.provenance.map((item) => item.sourceFactId) } } });
    if (current.length !== verification.provenance.length || current.some((fact) => !verification.provenance.some((item) => item.sourceFactId === fact.id && item.sourceChecksum === fact.checksum))) {
      throw new ResumeTailoringError('FACTS_CHANGED', 'Approved source facts changed while tailoring; retry with the current facts');
    }
    const version = await tx.resumeVersion.create({
      data: {
        resumeId, jobId, company: input.job.company, role: input.job.title, jdHash: sha256(input.job.description),
        content, htmlContent: htmlFromContent(content), keywordCoverage: tailored.keywordsAdded.length,
        changesFromMaster: tailored.changesFromMaster as unknown as Prisma.InputJsonValue, sourceFacts: provenance,
      },
    });
    await tx.auditLog.create({ data: { userId, action: 'RESUME_TAILORED', resource: 'ResumeVersion', resourceId: version.id, details: { resumeId, jobId, schemaVersion: tailored.schemaVersion, claims: verification.provenance.length } } });
    return version;
  });
}
