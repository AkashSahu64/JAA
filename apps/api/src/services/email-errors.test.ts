import { describe, expect, it } from 'vitest';
import { safeEmailErrorMessage } from './email-errors';

describe('email error boundary', () => {
  it('never reflects provider or persistence exception text to clients', () => {
    expect(safeEmailErrorMessage(new Error('postgres password=super-secret provider token=abc'), 'Email operation failed'))
      .toBe('Email operation failed');
    expect(safeEmailErrorMessage('credential leaked', 'OAuth callback failed')).toBe('OAuth callback failed');
  });
});
