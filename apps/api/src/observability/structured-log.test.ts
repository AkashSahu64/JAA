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

  it('preserves the event and correlation fields used for tracing', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writeStructuredLog('info', { event: 'http.request', correlationId: 'corr-1', applicationId: 'app-1' });
    expect(JSON.parse(output.mock.calls[0][0] as string)).toMatchObject({ event: 'http.request', correlationId: 'corr-1', applicationId: 'app-1' });
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
});
