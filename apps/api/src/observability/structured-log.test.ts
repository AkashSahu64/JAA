import { afterEach, describe, expect, it, vi } from 'vitest';
import { logRouteError, safeErrorMessage, writeStructuredLog } from './structured-log';

describe('structured logging boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('redacts sensitive fields and bounds nested values before emission', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStructuredLog('error', {
      event: 'fixture',
      password: 'must not appear',
      details: { pageText: 'hostile page content', note: 'x'.repeat(2_000) },
    });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.password).toBe('[REDACTED]');
    expect(record.details).toEqual({ pageText: '[REDACTED]', note: `${'x'.repeat(1_000)}…` });
  });

  it('redacts common cloud and bearer credential field names', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStructuredLog('error', {
      event: 'credential.fixture', apiKey: 'api-key', accessToken: 'access-token',
      refreshToken: 'refresh-token', privateKey: 'private-key', accessKeyId: 'access-key-id',
    });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ apiKey: '[REDACTED]', accessToken: '[REDACTED]', refreshToken: '[REDACTED]', privateKey: '[REDACTED]', accessKeyId: '[REDACTED]' });
  });

  it('redacts common candidate PII fields while preserving non-sensitive metadata', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStructuredLog('error', {
      event: 'candidate.fixture', email: 'candidate@example.invalid', phone: '+1-555-0100',
      address: '1 Example Street', dateOfBirth: '1990-01-01', ssn: '000-00-0000', attempt: 3,
    });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).toMatchObject({ email: '[REDACTED]', phone: '[REDACTED]', address: '[REDACTED]', dateOfBirth: '[REDACTED]', ssn: '[REDACTED]', attempt: 3 });
  });

  it('preserves the event and correlation fields used for tracing', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', { event: 'http.request', correlationId: 'corr-1', applicationId: 'app-1' });
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ event: 'http.request', correlationId: 'corr-1', applicationId: 'app-1' });
  });

  it('emits an explicit severity field for log collectors', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeStructuredLog('warn', { event: 'operations.alert' });
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ level: 'warn', event: 'operations.alert' });
  });

  it('does not allow caller metadata to spoof canonical severity or timestamp', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeStructuredLog('warn', { event: 'operations.alert', level: 'error', timestamp: 'forged' });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.level).toBe('warn');
    expect(record.timestamp).not.toBe('forged');
    expect(record.timestamp).toEqual(expect.any(String));
  });

  it('omits optional undefined context instead of serializing it as text', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', { event: 'worker', applicationId: undefined, provider: undefined });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).toEqual(expect.objectContaining({ event: 'worker' }));
    expect(record).not.toHaveProperty('applicationId');
    expect(record).not.toHaveProperty('provider');
  });

  it('does not let circular metadata break the logging path', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const details: Record<string, unknown> = { note: 'safe' };
    details.self = details;
    expect(() => writeStructuredLog('warn', { event: 'circular', details })).not.toThrow();
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ details: { note: 'safe', self: '[CIRCULAR]' } });
  });

  it('drops unsafe trace identifiers even when called outside the request boundary', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', {
      event: 'trace.boundary',
      correlationId: 'trace\nforged-field',
      applicationId: 'app-1',
      provider: 'lever.example/forged',
    });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).not.toHaveProperty('correlationId');
    expect(record).not.toHaveProperty('provider');
    expect(record.applicationId).toBe('app-1');
  });

  it('prevents control characters in event names from forging log lines', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', { event: 'worker\n{"level":"error","forged":true}' });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.event).toBe('invalid.event');
    expect(output.mock.calls[0][0]).not.toContain('forged');
  });

  it('drops invalid timing and retry metrics instead of emitting misleading values', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', {
      event: 'metrics.boundary', durationMs: Number.NaN, retryDelayMs: Number.POSITIVE_INFINITY,
      providerRetryAfterMs: -1, validMetric: 12.5,
    });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record).not.toHaveProperty('durationMs');
    expect(record).not.toHaveProperty('retryDelayMs');
    expect(record).not.toHaveProperty('providerRetryAfterMs');
    expect(record.validMetric).toBe(12.5);
  });

  it('redacts secrets embedded in error messages before route logging', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logRouteError('http.error', new Error('provider rejected Bearer abc.def; password=super-secret at https://example.invalid/cb?access_token=also-secret'));
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.errorMessage).toBe('provider rejected Bearer [REDACTED]; password=[REDACTED] at https://example.invalid/cb?access_token=[REDACTED]');
    expect(record.errorMessage).not.toContain('super-secret');
    expect(record.errorMessage).not.toContain('also-secret');
  });

  it('redacts raw JWT and Basic-auth material even without a credential key label', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStructuredLog('error', { event: 'auth.failure', error: 'Basic YWxpY2U6c2VjcmV0 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature-value' });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.error).toBe('Basic [REDACTED] [REDACTED_JWT]');
  });

  it('redacts secrets in generic runtime error metadata too', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeStructuredLog('error', { event: 'worker.failure', error: 'request failed Bearer abc.def?access_token=secret-value' });
    const record = JSON.parse(output.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(record.error).toBe('request failed Bearer [REDACTED]?access_token=[REDACTED]');
  });

  it('provides a bounded reusable sanitizer for durable error evidence', () => {
    expect(safeErrorMessage(new Error('token=secret-value\n' + 'x'.repeat(20)), 30))
      .toBe('token=[REDACTED] xxxxxxxxxxxx…');
  });

  it('does not let an untrusted error stringifier break the logging boundary', () => {
    const hostile = Object.assign(() => undefined, { toString: () => { throw new Error('stringification failed'); } });
    expect(safeErrorMessage(hostile)).toBe('[UNSERIALIZABLE]');
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => writeStructuredLog('error', { event: 'hostile.error', error: hostile })).not.toThrow();
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ error: '[UNSERIALIZABLE]' });
  });

  it('does not let throwing metadata getters break the logging boundary', () => {
    const hostile = Object.defineProperty({}, 'details', { enumerable: true, get: () => { throw new Error('getter failed'); } });
    const output = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => writeStructuredLog('warn', { event: 'hostile.metadata', hostile })).not.toThrow();
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ hostile: '[UNSERIALIZABLE]' });
  });

  it('fails closed for malformed top-level records', () => {
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => writeStructuredLog('error', null as never)).not.toThrow();
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ event: 'invalid.event', level: 'error' });
  });
});
