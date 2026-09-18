import { describe, expect, it } from 'vitest';
import { createHttpSpan, endpointFromEnvironment, exportHttpSpan } from './telemetry';

describe('OTLP telemetry boundary', () => {
  it('creates bounded HTTP spans without payload or secret attributes', () => {
    const span = createHttpSpan({ traceId: 'a'.repeat(32), name: 'GET /api/health', startAt: new Date('2026-09-16T00:00:00.000Z'), endAt: new Date('2026-09-16T00:00:00.010Z'), statusCode: 200, attributes: { 'http.status_code': 200, password: 'must-not-be-exported', 'x-good': 'bounded' } });
    expect(span).toMatchObject({ traceId: 'a'.repeat(32), name: 'GET /api/health', startTimeUnixNano: '1789516800000000000', endTimeUnixNano: '1789516800010000000' });
    expect(span.attributes).toEqual({ 'http.status_code': 200, 'x-good': 'bounded' });
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('exports a valid OTLP JSON span through the bounded injected transport', async () => {
    let request: { endpoint: string; body: string } | undefined;
    const ok = await exportHttpSpan(createHttpSpan({ traceId: 'b'.repeat(32), name: 'GET /api/health', startAt: new Date(0), endAt: new Date(1), statusCode: 503 }), {
      endpoint: 'https://telemetry.example.invalid/v1/traces',
      transport: async (endpoint, init) => { request = { endpoint, body: init.body }; return { ok: true }; },
    });
    expect(ok).toBe(true);
    expect(request?.endpoint).toBe('https://telemetry.example.invalid/v1/traces');
    expect(JSON.parse(request!.body)).toMatchObject({ resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: 'b'.repeat(32), status: { code: 2 } }] }] }] });
  });

  it('bounds malformed service-name environment input before export', async () => {
    const previous = process.env.OTEL_SERVICE_NAME;
    process.env.OTEL_SERVICE_NAME = `service\n${'x'.repeat(200)}`;
    let body = '';
    try {
      await expect(exportHttpSpan(createHttpSpan({ traceId: 'd'.repeat(32), name: 'GET /api/health', startAt: new Date(0), endAt: new Date(1), statusCode: 200 }), {
        endpoint: 'https://telemetry.example.invalid/v1/traces',
        transport: async (_endpoint, init) => { body = init.body; return { ok: true }; },
      })).resolves.toBe(true);
    } finally {
      if (previous === undefined) delete process.env.OTEL_SERVICE_NAME;
      else process.env.OTEL_SERVICE_NAME = previous;
    }
    expect(JSON.parse(body).resourceSpans[0].resource.attributes).toEqual([{ key: 'service.name', value: { stringValue: 'jobagent-api' } }]);
  });

  it('aborts a hanging telemetry transport within the configured bound', async () => {
    await expect(exportHttpSpan(createHttpSpan({ traceId: 'e'.repeat(32), name: 'GET /api/health', startAt: new Date(0), endAt: new Date(1), statusCode: 200 }), {
      endpoint: 'https://telemetry.example.invalid/v1/traces',
      timeoutMs: 100,
      transport: async (_endpoint, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    })).resolves.toBe(false);
  });

  it.each(['http://telemetry.example.invalid/v1/traces', 'https://user:secret@telemetry.example.invalid/v1/traces', 'https://telemetry.example.invalid/v1/traces?api_key=secret', 'not-a-url'])('fails closed for unsafe endpoint %s', async endpoint => {
    expect(endpointFromEnvironment({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint })).toBeUndefined();
    await expect(exportHttpSpan(createHttpSpan({ traceId: 'c'.repeat(32), name: 'GET /api/health', startAt: new Date(0), endAt: new Date(1), statusCode: 200 }), { endpoint })).resolves.toBe(false);
  });
});
