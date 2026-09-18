import { describe, expect, it } from 'vitest';
import { normalizeCorrelationId, normalizeTraceParent } from './request-logger';

describe('correlation id boundary', () => {
  it('preserves bounded structured correlation ids', () => {
    expect(normalizeCorrelationId('job-123:attempt_1')).toBe('job-123:attempt_1');
  });

  it.each(['', 'contains whitespace', 'a'.repeat(129), 'line\nbreak'])('replaces unsafe correlation ids with a generated id: %j', value => {
    const normalized = normalizeCorrelationId(value);
    expect(normalized).not.toBe(value);
    expect(normalized).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('W3C traceparent boundary', () => {
  it('preserves a valid traceparent while normalizing case', () => {
    expect(normalizeTraceParent('00-ABCDEF0123456789ABCDEF0123456789-ABCDEF0123456789-01'))
      .toBe('00-abcdef0123456789abcdef0123456789-abcdef0123456789-01');
  });

  it.each([undefined, '', '00-00000000000000000000000000000000-abcdef0123456789-01', 'garbage'])('generates a valid traceparent for malformed input: %j', value => {
    expect(normalizeTraceParent(value)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });
});
