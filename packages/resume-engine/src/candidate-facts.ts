import { createHash } from 'node:crypto';

export interface CandidateFactDraft {
  factType: string;
  value: Record<string, unknown>;
  sourceText: string;
  sourceStart: number;
  sourceEnd: number;
  checksum: string;
}

const SECTION_TYPES: Array<[RegExp, string]> = [
  [/^(professional\s*summary|summary|objective|profile|about\s*me)$/i, 'SUMMARY'],
  [/^(experience|work\s*experience|employment\s*history|professional\s*experience)$/i, 'EXPERIENCE'],
  [/^(education|academic\s*background|qualifications)$/i, 'EDUCATION'],
  [/^(skills|technical\s*skills|core\s*competencies|technologies)$/i, 'SKILL'],
  [/^(certifications?|licenses?|credentials)$/i, 'CERTIFICATION'],
  [/^(projects|personal\s*projects|portfolio)$/i, 'PROJECT'],
  [/^(awards?|honors?|achievements?)$/i, 'AWARD'],
  [/^(publications?|research)$/i, 'PUBLICATION'],
  [/^(languages?)$/i, 'LANGUAGE'],
  [/^(volunteer|community|extracurricular)$/i, 'VOLUNTEER'],
];

function canonicalHeading(line: string): string {
  return line.replace(/[:\-_|]+$/g, '').trim();
}

function checksum(factType: string, value: Record<string, unknown>, sourceStart: number, sourceEnd: number): string {
  return createHash('sha256')
    .update(JSON.stringify({ factType, value, sourceStart, sourceEnd }))
    .digest('hex');
}

function draft(factType: string, value: Record<string, unknown>, text: string, start: number, end: number): CandidateFactDraft {
  return {
    factType,
    value,
    sourceText: text.slice(start, end),
    sourceStart: start,
    sourceEnd: end,
    checksum: checksum(factType, value, start, end),
  };
}

function contentBounds(text: string, lineStart: number, lineEnd: number): [number, number] | null {
  const raw = text.slice(lineStart, lineEnd);
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const start = lineStart + leading;
  const end = lineEnd - trailing;
  return end > start ? [start, end] : null;
}

function splitSkills(text: string, start: number, end: number, section: string): CandidateFactDraft[] {
  const raw = text.slice(start, end);
  const facts: CandidateFactDraft[] = [];
  const tokenPattern = /[^,;•|]+/g;
  for (const match of raw.matchAll(tokenPattern)) {
    const token = match[0];
    const leading = token.length - token.trimStart().length;
    const trailing = token.length - token.trimEnd().length;
    let tokenStart = start + (match.index ?? 0) + leading;
    const tokenEnd = start + (match.index ?? 0) + token.length - trailing;
    while (tokenStart < tokenEnd && /^[-–—]$/.test(text[tokenStart])) tokenStart += 1;
    while (tokenStart < tokenEnd && /\s/.test(text[tokenStart])) tokenStart += 1;
    if (tokenEnd <= tokenStart) continue;
    const sourceText = text.slice(tokenStart, tokenEnd);
    const value = { text: sourceText, section };
    facts.push(draft('SKILL', value, text, tokenStart, tokenEnd));
  }
  return facts;
}

function contactFacts(text: string, start: number, end: number): CandidateFactDraft[] {
  const raw = text.slice(start, end);
  const patterns: Array<[RegExp, string]> = [
    [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, 'EMAIL'],
    [/https?:\/\/[^\s,;]+/gi, 'URL'],
    [/(?:\+?\d[\d\s().-]{7,}\d)/g, 'PHONE'],
  ];
  const facts: CandidateFactDraft[] = [];
  for (const [pattern, factType] of patterns) {
    for (const match of raw.matchAll(pattern)) {
      const factStart = start + (match.index ?? 0);
      const factEnd = factStart + match[0].length;
      facts.push(draft(factType, { text: match[0], section: 'CONTACT' }, text, factStart, factEnd));
    }
  }
  return facts;
}

export function extractCandidateFacts(text: string): CandidateFactDraft[] {
  const facts: CandidateFactDraft[] = [];
  let section = 'CONTACT';
  const linePattern = /[^\r\n]+/g;

  for (const lineMatch of text.matchAll(linePattern)) {
    const lineStart = lineMatch.index ?? 0;
    const lineEnd = lineStart + lineMatch[0].length;
    const bounds = contentBounds(text, lineStart, lineEnd);
    if (!bounds) continue;
    const [start, end] = bounds;
    const line = text.slice(start, end);
    const heading = SECTION_TYPES.find(([pattern]) => pattern.test(canonicalHeading(line)));
    if (heading) {
      section = heading[1];
      continue;
    }

    facts.push(...contactFacts(text, start, end));
    if (section === 'CONTACT') continue;
    if (section === 'SKILL') {
      facts.push(...splitSkills(text, start, end, section));
      continue;
    }
    const value = { text: line, section };
    facts.push(draft(section, value, text, start, end));
  }

  const unique = new Map(facts.map((fact) => [fact.checksum, fact]));
  return [...unique.values()];
}

export function normalizeCandidateClaim(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}
