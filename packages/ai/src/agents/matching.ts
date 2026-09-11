export interface MatchScoreResult {
  overall: number;
  roleMatch: number;
  skillMatch: number;
  experienceMatch: number;
  seniorityMatch: number;
  locationMatch: number;
  salaryMatch: number;
  technologyMatch: number;
  industryMatch: number;
  educationMatch: number;
  certificationMatch: number;
  workAuthorizationMatch: number;
  tier: 'EXCELLENT' | 'STRONG' | 'MODERATE' | 'WEAK' | 'NOT_RECOMMENDED';
  matchedSkills: string[];
  missingSkills: string[];
  matchedTechnologies: string[];
  missingTechnologies: string[];
  notes: string[];
}

export interface ProfileForMatching {
  currentRole?: string;
  yearsOfExperience: number;
  targetRoles: string[];
  seniority?: string;
  skills: Record<string, string[]>;
  experience: Array<{ company: string; position: string; technologies: string[]; responsibilities: string[] }>;
  education: Array<{ degree: string; field: string }>;
  certifications: Array<{ name: string }>;
  locationCountry?: string;
  locationCity?: string;
  remotePreference: string[];
  salaryMin?: number;
  salaryMax?: number;
  workAuthorized: boolean;
  sponsorshipNeeded: boolean;
}

export interface JobForMatching {
  title: string;
  company: string;
  location?: string;
  remoteType?: string;
  requirements: string[];
  skills: string[];
  seniority?: string;
  experienceMin?: number;
  experienceMax?: number;
  salaryMin?: number;
  salaryMax?: number;
  employmentType?: string;
  description: string;
  technologyStack?: string[];
}

export const MATCHING_VERSION = 'deterministic-match/1.0.0';
const WEIGHTS = { roleMatch: 0.18, skillMatch: 0.18, experienceMatch: 0.14, seniorityMatch: 0.08, locationMatch: 0.1, salaryMatch: 0.06, technologyMatch: 0.1, industryMatch: 0.04, educationMatch: 0.04, certificationMatch: 0.03, workAuthorizationMatch: 0.05 } as const;

function normalized(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9+#.]+/g, ' ').trim(); }
function unique(values: string[]): string[] { return [...new Set(values.map(normalized).filter(Boolean))]; }
function scoreOverlap(required: string[], available: string[]): { score: number; matched: string[]; missing: string[] } {
  const needed = unique(required);
  const owned = unique(available);
  if (needed.length === 0) return { score: 50, matched: [], missing: [] };
  const matched = needed.filter(term => owned.some(skill => skill === term || skill.includes(term) || term.includes(skill)));
  return { score: Math.round((matched.length / needed.length) * 100), matched, missing: needed.filter(term => !matched.includes(term)) };
}
function tier(overall: number): MatchScoreResult['tier'] { return overall >= 90 ? 'EXCELLENT' : overall >= 75 ? 'STRONG' : overall >= 60 ? 'MODERATE' : overall >= 40 ? 'WEAK' : 'NOT_RECOMMENDED'; }
function bounded(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }

export function calculateDeterministicMatch(profile: ProfileForMatching, job: JobForMatching): MatchScoreResult {
  const profileSkills = Object.values(profile.skills).flat();
  const experienceTerms = profile.experience.flatMap(item => [item.position, ...item.technologies, ...item.responsibilities]);
  const roleMatch = scoreOverlap([job.title], [profile.currentRole ?? '', ...profile.targetRoles, ...profile.experience.map(item => item.position)]).score;
  const skills = scoreOverlap([...job.skills, ...job.requirements], profileSkills);
  const technologies = scoreOverlap(job.technologyStack ?? job.skills, [...profileSkills, ...profile.experience.flatMap(item => item.technologies)]);
  const experienceMatch = job.experienceMin === undefined ? 50 : bounded((profile.yearsOfExperience / Math.max(1, job.experienceMin)) * 100);
  const seniorityMatch = !job.seniority ? 50 : normalized(profile.seniority ?? '') === normalized(job.seniority) ? 100 : 25;
  const isRemote = normalized(job.remoteType ?? job.location ?? '').includes('remote');
  const locationMatch = isRemote ? (profile.remotePreference.length ? 100 : 50) : scoreOverlap([job.location ?? ''], [profile.locationCity ?? '', profile.locationCountry ?? '']).score;
  const salaryMatch = job.salaryMin === undefined || profile.salaryMax === undefined ? 50 : profile.salaryMax >= job.salaryMin ? 100 : 0;
  const industryMatch = scoreOverlap([job.company], experienceTerms).score;
  const educationMatch = job.requirements.length === 0 ? 50 : scoreOverlap(job.requirements.filter(item => /degree|bachelor|master|phd/i.test(item)), profile.education.flatMap(item => [item.degree, item.field])).score;
  const certificationMatch = job.requirements.length === 0 ? 50 : scoreOverlap(job.requirements.filter(item => /certif|license/i.test(item)), profile.certifications.map(item => item.name)).score;
  const workAuthorizationMatch = profile.workAuthorized && !profile.sponsorshipNeeded ? 100 : profile.sponsorshipNeeded ? 25 : 0;
  const dimensions = { roleMatch, skillMatch: skills.score, experienceMatch, seniorityMatch, locationMatch, salaryMatch, technologyMatch: technologies.score, industryMatch, educationMatch, certificationMatch, workAuthorizationMatch };
  const overall = bounded(Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + dimensions[key as keyof typeof dimensions] * weight, 0));
  return { ...dimensions, overall, tier: tier(overall), matchedSkills: skills.matched, missingSkills: skills.missing, matchedTechnologies: technologies.matched, missingTechnologies: technologies.missing, notes: [`${MATCHING_VERSION}: weighted deterministic score`, `role=${roleMatch}; skills=${skills.score}; experience=${experienceMatch}; technology=${technologies.score}`] };
}

export class MatchingAgent {
  async calculateMatch(profile: ProfileForMatching, job: JobForMatching): Promise<MatchScoreResult> {
    return calculateDeterministicMatch(profile, job);
  }
}
