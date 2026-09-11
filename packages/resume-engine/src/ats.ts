import { createHash } from 'node:crypto';

export const ATS_SCORING_VERSION = 'deterministic-ats/1.0.0' as const;

export interface ATSIssue {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  location?: string;
  suggestion?: string;
}

export interface DeterministicATSScore {
  version: typeof ATS_SCORING_VERSION;
  overall: number;
  keywordAlignment: number;
  requiredSkillCoverage: number;
  jobTitleAlignment: number;
  experienceRelevance: number;
  formattingCompatibility: number;
  sectionDetection: number;
  parsingSafety: number;
  quantifiableAchievements: number;
  readabilityScore: number;
  issues: ATSIssue[];
  recommendations: string[];
  evidence: {
    inputHash: string;
    matchedKeywords: string[];
    missingKeywords: string[];
    matchedRequiredSkills: string[];
    missingRequiredSkills: string[];
    detectedSections: string[];
    signals: Record<string, boolean | number>;
  };
}

export interface ATSJobInput {
  title: string;
  description: string;
  requiredSkills: string[];
  mustHave?: string[];
}

const SECTION_PATTERNS: Array<[string, RegExp]> = [
  ['contact', /\b(?:email|phone|linkedin|github)\b/i],
  ['experience', /\b(?:work )?experience\b/i],
  ['education', /\beducation\b/i],
  ['skills', /\b(?:technical )?skills\b/i],
];

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[^a-z0-9+#.]+/g, ' ').trim();
}

function tokens(value: string): string[] {
  return normalized(value).match(/[a-z0-9+#.]{2,}/g) ?? [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function containsTerm(content: string, term: string): boolean {
  const normalizedTerm = normalized(term);
  return Boolean(normalizedTerm) && (` ${normalized(content)} `).includes(` ${normalizedTerm} `);
}

function overlap(required: string[], content: string): { matched: string[]; missing: string[]; score: number } {
  const terms = unique(required);
  if (terms.length === 0) return { matched: [], missing: [], score: 100 };
  const matched = terms.filter((term) => containsTerm(content, term));
  return { matched, missing: terms.filter((term) => !matched.includes(term)), score: 100 * matched.length / terms.length };
}

function inputHash(resume: string, job: ATSJobInput): string {
  return createHash('sha256').update(JSON.stringify({ version: ATS_SCORING_VERSION, resume, job }), 'utf8').digest('hex');
}

function issue(type: string, severity: ATSIssue['severity'], message: string, suggestion: string): ATSIssue {
  return { type, severity, message, suggestion };
}

export function calculateDeterministicATSScore(resumeContent: string, job: ATSJobInput): DeterministicATSScore {
  if (!resumeContent.trim()) throw new Error('Resume content is required');
  if (!job.title.trim()) throw new Error('Job title is required');
  const issues: ATSIssue[] = [];
  const recommendations: string[] = [];
  const lines = resumeContent.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedResume = normalized(resumeContent);
  const keywordTerms = unique([...tokens(job.title), ...tokens(job.description)]).filter((term) => term.length >= 3).slice(0, 80);
  const keyword = overlap(keywordTerms, resumeContent);
  const skills = overlap(unique([...(job.requiredSkills ?? []), ...(job.mustHave ?? [])]), resumeContent);
  const titleAligned = containsTerm(resumeContent, job.title);
  const experienceSignals = /\b(?:experience|engineer|developer|manager|analyst|architect|specialist)\b/i.test(resumeContent);
  const detectedSections = SECTION_PATTERNS.filter(([, pattern]) => lines.some((line) => pattern.test(line))).map(([name]) => name);
  const hasEmail = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(resumeContent);
  const hasPhone = /(?:\+?\d[\d\s().-]{7,}\d)/.test(resumeContent);
  const hasTableRisk = /\||\t/.test(resumeContent) || /<table\b/i.test(resumeContent);
  const hasColumnRisk = /(?:\s{4,}|│)/.test(resumeContent);
  const hasUnparseableCharacterRisk = [...resumeContent].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 && character !== '\n' && character !== '\r' && character !== '\t';
  });
  const dates = resumeContent.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const hasDateRisk = dates.length > 1 && dates.some((year, index) => index > 0 && Number(year) > Number(dates[index - 1]));
  const quantitative = (resumeContent.match(/(?:[$€£]\s*\d[\d,.]*|\b\d[\d,.]*\s*(?:%|x\b|users?\b|customers?\b|requests?\b|days?\b|hours?\b))/gi) ?? []).length;
  const averageLineLength = lines.length ? lines.reduce((sum, line) => sum + line.length, 0) / lines.length : 0;
  const repeatedTerms = tokens(resumeContent).reduce<Record<string, number>>((counts, token) => ({ ...counts, [token]: (counts[token] ?? 0) + 1 }), {});
  const keywordStuffing = Object.values(repeatedTerms).some((count) => count >= 12);

  if (keyword.missing.length) { issues.push(issue('MISSING_KEYWORDS', 'warning', `Missing ${keyword.missing.length} relevant job keywords`, 'Add only keywords supported by approved candidate facts.')); recommendations.push('Incorporate supported missing job keywords naturally.'); }
  if (skills.missing.length) { issues.push(issue('MISSING_REQUIRED_SKILLS', 'warning', `Missing ${skills.missing.length} required skills`, 'Do not add skills unless supported by approved candidate facts.')); recommendations.push('Review required-skill gaps before applying.'); }
  if (!titleAligned) { issues.push(issue('TITLE_ALIGNMENT', 'info', 'Target job title is not present', 'Use an accurate, supported role title in the summary or experience section.')); recommendations.push('Clarify supported role alignment.'); }
  if (detectedSections.length < SECTION_PATTERNS.length) { issues.push(issue('MISSING_SECTIONS', 'warning', 'One or more standard resume sections were not detected', 'Use standard Contact, Experience, Education, and Skills headings when truthful.')); recommendations.push('Use standard ATS-recognized section headings.'); }
  if (!hasEmail || !hasPhone) { issues.push(issue('CONTACT_INFO', 'warning', 'Email or phone contact information was not detected', 'Include current contact information.')); recommendations.push('Verify contact information.'); }
  if (hasTableRisk || hasColumnRisk) { issues.push(issue('FORMAT_RISK', 'warning', 'Table or multi-column formatting may parse poorly', 'Use a single-column, text-based layout.')); recommendations.push('Use a simple single-column layout.'); }
  if (hasUnparseableCharacterRisk) { issues.push(issue('PARSING_RISK', 'critical', 'Control characters can break ATS parsing', 'Remove unsupported control characters.')); recommendations.push('Remove non-printable characters.'); }
  if (hasDateRisk) { issues.push(issue('DATE_ORDER', 'info', 'Dates appear out of chronological order', 'Verify dates and use a consistent reverse-chronological format.')); recommendations.push('Review date ordering.'); }
  if (keywordStuffing) { issues.push(issue('KEYWORD_STUFFING', 'warning', 'Repeated terms indicate potential keyword stuffing', 'Remove repeated unsupported or unnatural keywords.')); recommendations.push('Avoid keyword stuffing.'); }

  const formattingCompatibility = clamp(100 - (hasTableRisk ? 40 : 0) - (hasColumnRisk ? 20 : 0));
  const parsingSafety = clamp(100 - (hasUnparseableCharacterRisk ? 70 : 0) - (hasTableRisk ? 10 : 0));
  const sectionDetection = clamp(100 * detectedSections.length / SECTION_PATTERNS.length);
  const contactScore = hasEmail && hasPhone ? 100 : hasEmail || hasPhone ? 60 : 0;
  const readabilityScore = clamp(100 - Math.max(0, averageLineLength - 120) / 2 - (keywordStuffing ? 30 : 0));
  const score = {
    keywordAlignment: clamp(keyword.score), requiredSkillCoverage: clamp(skills.score), jobTitleAlignment: titleAligned ? 100 : 0,
    experienceRelevance: experienceSignals ? 100 : 30, formattingCompatibility, sectionDetection,
    parsingSafety, quantifiableAchievements: clamp(Math.min(100, quantitative * 25)), readabilityScore,
  };
  const overall = clamp(
    score.keywordAlignment * 0.30 + score.requiredSkillCoverage * 0.20 + score.jobTitleAlignment * 0.10 +
    score.experienceRelevance * 0.10 + score.formattingCompatibility * 0.10 + score.sectionDetection * 0.05 +
    score.parsingSafety * 0.05 + score.quantifiableAchievements * 0.05 + score.readabilityScore * 0.05,
  );
  return {
    version: ATS_SCORING_VERSION, overall, ...score, issues, recommendations: unique(recommendations),
    evidence: { inputHash: inputHash(resumeContent, job), matchedKeywords: keyword.matched, missingKeywords: keyword.missing, matchedRequiredSkills: skills.matched, missingRequiredSkills: skills.missing, detectedSections, signals: { hasEmail, hasPhone, hasTableRisk, hasColumnRisk, hasUnparseableCharacterRisk, hasDateRisk, keywordStuffing, quantitative, contactScore } },
  };
}
