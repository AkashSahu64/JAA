import { describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from './error-handler';

function responseDouble() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
}

const requestDouble = { header: () => undefined };

describe('HTTP error boundary', () => {
  it('preserves valid operational client statuses', () => {
    const response = responseDouble();
    errorHandler(new AppError(422, 'invalid input'), requestDouble as never, response as never, vi.fn());
    expect(response.status).toHaveBeenCalledWith(422);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: 'invalid input' });
  });

  it.each([0, 399, 600, Number.NaN, Number.POSITIVE_INFINITY])('fails closed for invalid operational status %s', statusCode => {
    const response = responseDouble();
    errorHandler(new AppError(statusCode, 'internal detail'), requestDouble as never, response as never, vi.fn());
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: 'An internal error occurred' });
  });

  it('does not expose an AppError message for server-error statuses', () => {
    const response = responseDouble();
    errorHandler(new AppError(500, 'database password=secret'), requestDouble as never, response as never, vi.fn());
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: 'An internal error occurred' });
  });

  it('normalizes non-Error thrown values without breaking the error response', () => {
    const response = responseDouble();
    expect(() => errorHandler('database password=secret' as never, requestDouble as never, response as never, vi.fn())).not.toThrow();
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ success: false, error: 'An internal error occurred' });
  });
});
