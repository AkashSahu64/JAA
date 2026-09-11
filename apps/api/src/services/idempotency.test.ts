import { describe, expect, it } from 'vitest';
import { hashIdempotencyRequest, IdempotencyError } from './idempotency';

describe('durable idempotency request identity', () => {
  it('hashes object keys canonically while preserving array order', () => {
    expect(hashIdempotencyRequest({ a: 1, b: { c: true } }))
      .toBe(hashIdempotencyRequest({ b: { c: true }, a: 1 }));
    expect(hashIdempotencyRequest([1, 2])).not.toBe(hashIdempotencyRequest([2, 1]));
  });

  it('exposes stable command error codes', () => {
    const error = new IdempotencyError('REQUEST_CONFLICT', 'conflict');
    expect(error.name).toBe('IdempotencyError');
    expect(error.code).toBe('REQUEST_CONFLICT');
  });
});
