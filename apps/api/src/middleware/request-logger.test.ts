import { describe, expect, it } from 'vitest';
import { normalizeCorrelationId } from './request-logger';

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
