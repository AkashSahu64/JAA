import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { isRecord, parseLimit, parsePagination, pick, validateBody } from './validate';

function runValidation(body: unknown, schema: Parameters<typeof validateBody>[0]) {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const next = vi.fn();
  validateBody(schema)({ body } as Request, { status } as unknown as Response, next as NextFunction);
  return { status, json, next };
}

describe('validateBody', () => {
  const schema = {
    name: { type: 'string', required: true, minLength: 2, maxLength: 5 },
    score: { type: 'number', min: 0, max: 10 },
    enabled: { type: 'boolean' },
    metadata: { type: 'object' },
    tags: { type: 'array' },
  } as const;

  it('calls next for a body matching all supported rule types', () => {
    const result = runValidation({ name: 'Ada', score: 10, enabled: false, metadata: {}, tags: [] }, schema);
    expect(result.next).toHaveBeenCalledOnce();
    expect(result.status).not.toHaveBeenCalled();
  });

  it('rejects non-object bodies before reading fields', () => {
    const result = runValidation(null, schema);
    expect(result.status).toHaveBeenCalledWith(400);
    expect(result.json).toHaveBeenCalledWith({ success: false, error: 'Request body must be a JSON object' });
    expect(result.next).not.toHaveBeenCalled();
  });

  it('collects required, type, string, numeric, and finite-number errors', () => {
    const result = runValidation({ name: 'x', score: Number.POSITIVE_INFINITY, enabled: 'yes', metadata: [], tags: {} }, schema);
    const response = result.json.mock.calls[0][0];
    expect(response.errors).toEqual(expect.arrayContaining([
      'name must be at least 2 characters',
      'score must be finite',
      'score must be at most 10',
      'enabled must be a boolean',
      'metadata must be a object',
      'tags must be an array',
    ]));
  });
});

describe('validation helpers', () => {
  it('recognizes plain record-shaped values', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });

  it('picks own properties only', () => {
    const body = Object.assign(Object.create({ inherited: 'no' }), { id: 1, name: 'Ada' });
    expect(pick(body, ['id', 'inherited', 'missing'] as const)).toEqual({ id: 1 });
    expect(pick(null, ['id'] as const)).toEqual({});
  });

  it('parses pagination defaults and strict decimal integers', () => {
    expect(parsePagination({})).toEqual({ page: 0, pageSize: 25 });
    expect(parsePagination({ page: '2', pageSize: '100' })).toEqual({ page: 2, pageSize: 100 });
    expect(parsePagination({ page: '-1' })).toBeNull();
    expect(parsePagination({ page: '1e1' })).toBeNull();
    expect(parsePagination({ page: '0x10' })).toBeNull();
    expect(parsePagination({ page: ['1'] })).toBeNull();
    expect(parsePagination({ pageSize: '101' })).toBeNull();
  });

  it('parses limits without coercing whitespace or alternate numeric formats', () => {
    expect(parseLimit(undefined, 20, 50)).toBe(20);
    expect(parseLimit('50', 20, 50)).toBe(50);
    expect(parseLimit('0', 20, 50)).toBeNull();
    expect(parseLimit(' 5 ', 20, 50)).toBeNull();
    expect(parseLimit('1e1', 20, 50)).toBeNull();
    expect(parseLimit(3.5, 20, 50)).toBeNull();
  });
});
