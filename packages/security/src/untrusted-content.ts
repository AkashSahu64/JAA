import { createHash } from 'node:crypto';

export const DEFAULT_MAX_UNTRUSTED_CONTENT_BYTES = 256 * 1024;

export type UntrustedContentSourceKind = 'WEB_PAGE' | 'JOB_DESCRIPTION';
export type UntrustedContentRisk = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type UntrustedContentIndicatorSeverity = Exclude<UntrustedContentRisk, 'NONE'>;

export interface UntrustedContentIndicator {
  readonly code:
    | 'INSTRUCTION_OVERRIDE'
    | 'ROLE_OR_POLICY_IMPERSONATION'
    | 'TOOL_EXECUTION_REQUEST'
    | 'SECRET_EXFILTRATION_REQUEST'
    | 'HIDDEN_FROM_USER_REQUEST'
    | 'ENCODED_INSTRUCTION_REQUEST';
  readonly severity: UntrustedContentIndicatorSeverity;
  readonly occurrences: number;
}

export interface UntrustedContentInput {
  readonly content: string;
  readonly sourceKind: UntrustedContentSourceKind;
  /** Provenance only. A source URL never grants authority. */
  readonly sourceUrl?: string;
}

export interface UntrustedContentBoundaryOptions {
  readonly maxBytes?: number;
}

export interface UntrustedContentEnvelope {
  readonly schemaVersion: 1;
  readonly boundary: {
    readonly trust: 'UNTRUSTED';
    readonly interpretation: 'DATA_ONLY';
    readonly grantsPolicyAuthority: false;
    readonly grantsToolAuthority: false;
    readonly embeddedInstructionsAreAuthoritative: false;
  };
  readonly source: {
    readonly kind: UntrustedContentSourceKind;
    readonly url?: string;
  };
  readonly payload: {
    readonly mediaType: 'text/plain';
    /** Original input, preserved exactly. */
    readonly text: string;
    readonly utf8Bytes: number;
    readonly sha256: string;
  };
  readonly assessment: {
    readonly risk: UntrustedContentRisk;
    readonly instructionLikeContentDetected: boolean;
    readonly indicators: readonly UntrustedContentIndicator[];
  };
}

interface IndicatorRule {
  readonly code: UntrustedContentIndicator['code'];
  readonly severity: UntrustedContentIndicatorSeverity;
  readonly pattern: RegExp;
}

const INDICATOR_RULES: readonly IndicatorRule[] = [
  {
    code: 'INSTRUCTION_OVERRIDE',
    severity: 'HIGH',
    pattern: /\b(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|earlier|system|developer)\s+(?:instructions?|prompts?|messages?|rules?)\b/giu,
  },
  {
    code: 'ROLE_OR_POLICY_IMPERSONATION',
    severity: 'MEDIUM',
    pattern: /(?:^|\n)\s*(?:<\/?\s*)?(?:system|developer|assistant)(?:\s+message|\s+instructions?)?\s*(?::|>)/giu,
  },
  {
    code: 'TOOL_EXECUTION_REQUEST',
    severity: 'HIGH',
    pattern: /\b(?:you\s+(?:must|should)|please|must)\s+(?:call|invoke|use|run|execute)\s+(?:the\s+)?(?:tool|function|command|shell|terminal)\b/giu,
  },
  {
    code: 'SECRET_EXFILTRATION_REQUEST',
    severity: 'CRITICAL',
    pattern: /\b(?:reveal|print|return|send|upload|exfiltrate|show)\s+(?:the\s+|all\s+)?(?:system\s+prompt|developer\s+message|api\s+keys?|credentials?|secrets?|environment\s+variables?)\b/giu,
  },
  {
    code: 'HIDDEN_FROM_USER_REQUEST',
    severity: 'HIGH',
    pattern: /\b(?:do\s+not|don't)\s+(?:tell|inform|notify|mention\s+this\s+to)\s+(?:the\s+)?user\b/giu,
  },
  {
    code: 'ENCODED_INSTRUCTION_REQUEST',
    severity: 'MEDIUM',
    pattern: /\b(?:decode|base64[- ]decode)\s+(?:this|the\s+following).{0,48}\b(?:follow|execute|obey)\b/giu,
  },
] as const;

export class UntrustedContentSizeError extends RangeError {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`Untrusted content is ${actualBytes} UTF-8 bytes; maximum is ${maxBytes}`);
    this.name = 'UntrustedContentSizeError';
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

function normalizeForDetection(content: string): string {
  // Detection normalization does not modify the preserved payload. Removing common
  // invisible format characters catches simple attempts to split indicator words.
  const invisibleFormatCharacters = new RegExp('[\\u200B-\\u200D\\u2060\\uFEFF]', 'gu');
  return content.normalize('NFKC').replace(invisibleFormatCharacters, '').replace(/\r\n?/gu, '\n');
}

function detectIndicators(content: string): readonly UntrustedContentIndicator[] {
  const detectionText = normalizeForDetection(content);
  return INDICATOR_RULES.flatMap(rule => {
    const occurrences = Array.from(detectionText.matchAll(rule.pattern)).length;
    return occurrences ? [{ code: rule.code, severity: rule.severity, occurrences }] : [];
  });
}

function classifyRisk(indicators: readonly UntrustedContentIndicator[]): UntrustedContentRisk {
  const rank: Record<UntrustedContentIndicatorSeverity, number> = {
    LOW: 1,
    MEDIUM: 2,
    HIGH: 3,
    CRITICAL: 4,
  };
  let result: UntrustedContentRisk = 'NONE';
  let highest = 0;
  for (const indicator of indicators) {
    if (rank[indicator.severity] > highest) {
      highest = rank[indicator.severity];
      result = indicator.severity;
    }
  }
  return result;
}

export function createUntrustedContentEnvelope(
  input: UntrustedContentInput,
  options: UntrustedContentBoundaryOptions = {},
): UntrustedContentEnvelope {
  if (typeof input?.content !== 'string') throw new TypeError('Untrusted content must be a string');
  if (input.sourceKind !== 'WEB_PAGE' && input.sourceKind !== 'JOB_DESCRIPTION') {
    throw new TypeError('Untrusted content sourceKind must be WEB_PAGE or JOB_DESCRIPTION');
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UNTRUSTED_CONTENT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError('maxBytes must be a positive safe integer');
  }
  const utf8Bytes = Buffer.byteLength(input.content, 'utf8');
  if (utf8Bytes > maxBytes) throw new UntrustedContentSizeError(utf8Bytes, maxBytes);

  const indicators = Object.freeze(detectIndicators(input.content).map(indicator => Object.freeze(indicator)));
  return Object.freeze({
    schemaVersion: 1,
    boundary: Object.freeze({
      trust: 'UNTRUSTED',
      interpretation: 'DATA_ONLY',
      grantsPolicyAuthority: false,
      grantsToolAuthority: false,
      embeddedInstructionsAreAuthoritative: false,
    }),
    source: Object.freeze({ kind: input.sourceKind, ...(input.sourceUrl === undefined ? {} : { url: input.sourceUrl }) }),
    payload: Object.freeze({
      mediaType: 'text/plain',
      text: input.content,
      utf8Bytes,
      sha256: createHash('sha256').update(input.content, 'utf8').digest('hex'),
    }),
    assessment: Object.freeze({
      risk: classifyRisk(indicators),
      instructionLikeContentDetected: indicators.length > 0,
      indicators,
    }),
  });
}
