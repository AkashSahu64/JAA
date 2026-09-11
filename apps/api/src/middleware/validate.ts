import { Request, Response, NextFunction } from 'express';

export type ValidationSchema = {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'object' | 'array';
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    min?: number;
    max?: number;
  };
};

export function validateBody(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const errors: string[] = [];
    if (!isRecord(req.body)) {
      res.status(400).json({ success: false, error: 'Request body must be a JSON object' });
      return;
    }

    for (const [field, rules] of Object.entries(schema)) {
      const value = req.body[field];
      if (rules.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field} is required`);
        continue;
      }
      if (value === undefined || value === null) continue;

      const validType = rules.type === 'array'
        ? Array.isArray(value)
        : rules.type === 'object'
          ? isRecord(value)
          : typeof value === rules.type;
      if (!validType) {
        errors.push(`${field} must be ${rules.type === 'array' ? 'an array' : `a ${rules.type}`}`);
        continue;
      }

      if (typeof value === 'string') {
        if (rules.minLength !== undefined && value.length < rules.minLength) errors.push(`${field} must be at least ${rules.minLength} characters`);
        if (rules.maxLength !== undefined && value.length > rules.maxLength) errors.push(`${field} must be at most ${rules.maxLength} characters`);
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) errors.push(`${field} must be finite`);
        if (rules.min !== undefined && value < rules.min) errors.push(`${field} must be at least ${rules.min}`);
        if (rules.max !== undefined && value > rules.max) errors.push(`${field} must be at most ${rules.max}`);
      }
    }

    if (errors.length > 0) {
      res.status(400).json({ success: false, errors });
      return;
    }
    next();
  };
}

export function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pick<T extends readonly string[]>(body: unknown, fields: T): Partial<Record<T[number], any>> {
  if (!isRecord(body)) return {};
  return Object.fromEntries(fields.filter(field => Object.prototype.hasOwnProperty.call(body, field)).map(field => [field, body[field]])) as Partial<Record<T[number], any>>;
}

export function parsePagination(query: Request['query'], defaultPageSize = 25): { page: number; pageSize: number } | null {
  const page = query.page === undefined ? 0 : parseInteger(query.page);
  const pageSize = query.pageSize === undefined ? defaultPageSize : parseInteger(query.pageSize);
  if (page === null || page < 0 || pageSize === null || pageSize < 1 || pageSize > 100) return null;
  return { page, pageSize };
}

export function parseLimit(value: unknown, fallback: number, max: number): number | null {
  if (value === undefined) return fallback;
  const parsed = parseInteger(value);
  return parsed !== null && parsed > 0 && parsed <= max ? parsed : null;
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
