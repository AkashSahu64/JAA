import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { calculateDeterministicMatch, MATCHING_VERSION, type ProfileForMatching } from '@jobagent/ai';
import { withTenant } from '@jobagent/database';

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function stringArrayRecord(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, items]) => [key, stringArray(items)]));
}

function profileForMatching(profile: {
  currentRole: string | null; yearsOfExperience: number; targetRoles: string[]; seniority: string | null; skills: Prisma.JsonValue;
  experience: Prisma.JsonValue; education: Prisma.JsonValue; certifications: Prisma.JsonValue; locationCountry: string | null;
  locationCity: string | null; locationPreferences: Prisma.JsonValue; salaryPreference: Prisma.JsonValue | null; workAuthorized: boolean; sponsorshipNeeded: boolean;
}): ProfileForMatching {
  const salary = profile.salaryPreference && typeof profile.salaryPreference === 'object' && !Array.isArray(profile.salaryPreference)
    ? profile.salaryPreference as Record<string, unknown> : {};
  const experience = Array.isArray(profile.experience) ? profile.experience.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    return [{ company: typeof value.company === 'string' ? value.company : '', position: typeof value.position === 'string' ? value.position : '', technologies: stringArray(value.technologies), responsibilities: stringArray(value.responsibilities) }];
  }) : [];
  const education = Array.isArray(profile.education) ? profile.education.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const value = item as Record<string, unknown>;
    return [{ degree: typeof value.degree === 'string' ? value.degree : '', field: typeof value.field === 'string' ? value.field : '' }];
  }) : [];
  const certifications = Array.isArray(profile.certifications) ? profile.certifications.flatMap((item) => {
    if (typeof item === 'string') return [{ name: item }];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const name = (item as Record<string, unknown>).name;
    return typeof name === 'string' ? [{ name }] : [];
  }) : [];
  return {
    currentRole: profile.currentRole ?? undefined, yearsOfExperience: profile.yearsOfExperience, targetRoles: profile.targetRoles,
    seniority: profile.seniority ?? undefined, skills: stringArrayRecord(profile.skills), experience, education, certifications,
    locationCountry: profile.locationCountry ?? undefined, locationCity: profile.locationCity ?? undefined,
    remotePreference: stringArray(profile.locationPreferences), salaryMin: typeof salary.min === 'number' ? salary.min : undefined,
    salaryMax: typeof salary.max === 'number' ? salary.max : undefined, workAuthorized: profile.workAuthorized, sponsorshipNeeded: profile.sponsorshipNeeded,
  };
}

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex'); }

export async function executeJobMatch(userId: string, jobId: string) {
  return withTenant(userId, async tx => {
    const [profile, job] = await Promise.all([
      tx.userProfile.findUnique({ where: { userId } }),
      tx.job.findUnique({ where: { id: jobId }, include: { analysis: { select: { technologyStack: true } } } }),
    ]);
    if (!profile) throw new Error('User profile is required before matching jobs');
    if (!job) throw new Error('Job not found');
    const candidate = profileForMatching(profile);
    const jobInput = {
      title: job.title, company: job.company, location: job.location ?? undefined, remoteType: job.remoteType ?? undefined,
      requirements: job.requirements, skills: job.skills, seniority: job.seniority ?? undefined,
      experienceMin: job.experienceMin ?? undefined, experienceMax: job.experienceMax ?? undefined,
      salaryMin: job.salaryMin ?? undefined, salaryMax: job.salaryMax ?? undefined, employmentType: job.employmentType ?? undefined,
      description: job.description, technologyStack: job.analysis?.technologyStack ?? undefined,
    };
    const result = calculateDeterministicMatch(candidate, jobInput);
    const evidence = {
      version: MATCHING_VERSION, dimensions: {
        role: result.roleMatch, skills: result.skillMatch, experience: result.experienceMatch, seniority: result.seniorityMatch,
        location: result.locationMatch, salary: result.salaryMatch, technology: result.technologyMatch, industry: result.industryMatch,
        education: result.educationMatch, certification: result.certificationMatch, workAuthorization: result.workAuthorizationMatch,
      }, matchedSkills: result.matchedSkills, missingSkills: result.missingSkills, matchedTechnologies: result.matchedTechnologies, missingTechnologies: result.missingTechnologies,
    };
    return tx.jobMatch.upsert({
      where: { jobId_userId: { jobId, userId } },
      update: { ...result, matchingVersion: MATCHING_VERSION, evidence: evidence as Prisma.InputJsonValue, profileHash: hash(candidate), jobHash: hash(jobInput), calculatedAt: new Date() },
      create: { jobId, userId, ...result, matchingVersion: MATCHING_VERSION, evidence: evidence as Prisma.InputJsonValue, profileHash: hash(candidate), jobHash: hash(jobInput) },
    });
  });
}
