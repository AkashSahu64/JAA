import { Prisma } from '@prisma/client';
import { withTenant } from '@jobagent/database';
import { calculateDeterministicATSScore } from '@jobagent/resume-engine';

export class ATSEvaluationError extends Error {
  constructor(public readonly code: 'INVALID' | 'NOT_FOUND', message: string) {
    super(message);
    this.name = 'ATSEvaluationError';
  }
}

export async function executeATSEvaluation(userId: string, resumeVersionId: string) {
  if (!userId.trim() || !resumeVersionId.trim()) throw new ATSEvaluationError('INVALID', 'User and resume version identifiers are required');
  return withTenant(userId, async (tx) => {
    const version = await tx.resumeVersion.findFirst({
      where: { id: resumeVersionId, resume: { userId } },
      select: {
        id: true, content: true,
        job: { select: { title: true, description: true, skills: true, analysis: { select: { mustHave: true } } } },
      },
    });
    if (!version || !version.job) throw new ATSEvaluationError('NOT_FOUND', 'Resume version or associated job not found');
    const score = calculateDeterministicATSScore(version.content, {
      title: version.job.title,
      description: version.job.description,
      requiredSkills: version.job.skills,
      mustHave: version.job.analysis?.mustHave ?? [],
    });
    const updated = await tx.resumeVersion.update({
      where: { id: version.id },
      data: { atsScoreOverall: score.overall, atsScoreData: score as unknown as Prisma.InputJsonValue },
    });
    await tx.auditLog.create({
      data: {
        userId,
        action: 'RESUME_ATS_EVALUATED',
        resource: 'ResumeVersion',
        resourceId: version.id,
        details: { version: score.version, overall: score.overall, inputHash: score.evidence.inputHash },
      },
    });
    return updated;
  });
}
