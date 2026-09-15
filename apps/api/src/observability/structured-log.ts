export type StructuredLogLevel = 'info' | 'error' | 'warn';

export interface StructuredLogRecord {
  event: string;
  correlationId?: string;
  applicationId?: string;
  automationJobId?: string;
  provider?: string;
  userId?: string;
  [key: string]: unknown;
}

const MAX_STRING_LENGTH = 1_000;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;
const MAX_DEPTH = 3;
const SENSITIVE_KEY = /(?:password|secret|token|credential|cookie|authorization|apiKey|accessKey|privateKey|pageText|body|answer|resume|coverLetter|documentContent)/i;
const TRACE_KEYS = new Set(['correlationId', 'applicationId', 'automationJobId', 'provider', 'userId']);
const SAFE_TRACE_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_EVENT_VALUE = /^[A-Za-z0-9._:-]{1,128}$/;
const NON_NEGATIVE_METRIC_KEYS = new Set(['durationMs', 'retryDelayMs', 'providerRetryAfterMs']);

export function redactSensitiveMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/(\b(?:password|passphrase|secret|token|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=])\s*[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/([?&](?:access[_-]?token|refresh[_-]?token|api[_-]?key|secret|signature)=)[^&#\s]+/giu, '$1[REDACTED]');
}

export function safeErrorMessage(error: unknown, maxLength = 10_000): string {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = Array.from(message, character => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? ' ' : character;
  }).join('');
  const redacted = redactSensitiveMessage(sanitized);
  return redacted.length > maxLength ? `${redacted.slice(0, Math.max(0, maxLength - 1))}…` : redacted;
}

function boundedValue(value: unknown, depth: number, seen = new WeakSet<object>()): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const redacted = redactSensitiveMessage(value);
    return redacted.length > MAX_STRING_LENGTH ? `${redacted.slice(0, MAX_STRING_LENGTH)}…` : redacted;
  }
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
  }
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map(item => boundedValue(item, depth + 1, seen));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_KEYS)) {
      const bounded = SENSITIVE_KEY.test(key) ? '[REDACTED]' : boundedValue(nested, depth + 1, seen);
      if (bounded !== undefined) result[key] = bounded;
    }
    return result;
  }
  return String(value).slice(0, MAX_STRING_LENGTH);
}

export function writeStructuredLog(level: StructuredLogLevel, record: StructuredLogRecord): void {
  const safeRecord = boundedValue(record, 0) as Record<string, unknown>;
  if (typeof safeRecord.event !== 'string' || !SAFE_EVENT_VALUE.test(safeRecord.event)) safeRecord.event = 'invalid.event';
  for (const key of TRACE_KEYS) {
    const value = safeRecord[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !SAFE_TRACE_VALUE.test(value)) delete safeRecord[key];
  }
  for (const key of NON_NEGATIVE_METRIC_KEYS) {
    const value = safeRecord[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) delete safeRecord[key];
  }
  const serialized = JSON.stringify({ timestamp: new Date().toISOString(), ...safeRecord });
  if (level === 'error') console.error(serialized);
  else if (level === 'warn') console.warn(serialized);
  else console.log(serialized);
}

export function logRouteError(event: string, error: unknown, context: Pick<StructuredLogRecord, 'correlationId' | 'applicationId' | 'automationJobId' | 'provider' | 'userId'> = {}): void {
  writeStructuredLog('error', {
    event,
    ...context,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    errorMessage: error instanceof Error ? redactSensitiveMessage(error.message) : 'unknown error',
  });
}
