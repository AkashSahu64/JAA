import { randomBytes } from 'node:crypto';

export interface HttpSpan {
  traceId: string;
  spanId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  statusCode: number;
}

export interface TelemetryTransport {
  (endpoint: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ ok: boolean }>;
}

function endpointFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (!value) return undefined;
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return undefined;
    return endpoint.href;
  } catch {
    return undefined;
  }
}

function nanoTime(date: Date): string {
  return `${BigInt(date.getTime()) * 1_000_000n}`;
}

function boundedAttributes(attributes: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(attributes).filter(([key, value]) => /^[a-zA-Z0-9_.-]{1,80}$/.test(key)
    && !/(?:password|secret|token|credential|cookie|authorization|api[_-]?key|access[_-]?key|body|answer|document|resume)/i.test(key)
    && ((typeof value === 'string' && value.length <= 200) || (typeof value === 'number' && Number.isFinite(value)))));
}

function serviceName(): string {
  const value = process.env.OTEL_SERVICE_NAME?.trim();
  if (!value || value.length > 100 || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    return 'jobagent-api';
  }
  return value;
}

export function createHttpSpan(input: {
  traceId: string;
  name: string;
  startAt: Date;
  endAt: Date;
  statusCode: number;
  attributes?: Record<string, string | number>;
}): HttpSpan {
  const spanId = randomBytes(8).toString('hex');
  return {
    traceId: input.traceId,
    spanId,
    name: input.name.slice(0, 100),
    startTimeUnixNano: nanoTime(input.startAt),
    endTimeUnixNano: nanoTime(input.endAt),
    attributes: boundedAttributes(input.attributes ?? {}),
    statusCode: input.statusCode,
  };
}

export async function exportHttpSpan(
  span: HttpSpan,
  options: { endpoint?: string; timeoutMs?: number; transport?: TelemetryTransport } = {},
): Promise<boolean> {
  const endpoint = options.endpoint ?? endpointFromEnvironment();
  if (!endpoint) return false;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) return false;
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  } catch {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const transport = options.transport ?? (async (url, init) => fetch(url, init));
    const result = await transport(parsed.href, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName() } }] }, scopeSpans: [{ spans: [{ traceId: span.traceId, spanId: span.spanId, name: span.name, startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano, attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: value } : { stringValue: value } })), status: { code: span.statusCode >= 500 ? 2 : 1 } }] }] }] }),
      signal: controller.signal,
    });
    return result.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export { endpointFromEnvironment };
