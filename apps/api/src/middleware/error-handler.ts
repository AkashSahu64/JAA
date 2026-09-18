import { Request, Response, NextFunction } from 'express';
import { writeStructuredLog } from '../observability/structured-log';
import { normalizeCorrelationId } from './request-logger';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const normalizedError = err instanceof Error ? err : new Error('Unknown error');
  writeStructuredLog('error', {
    event: 'http.error',
    correlationId: normalizeCorrelationId(_req.header('x-correlation-id')),
    userId: (_req as Request & { user?: { userId?: string } }).user?.userId,
    errorName: normalizedError.name,
    errorMessage: normalizedError.message,
  });
  
  if (normalizedError instanceof AppError && Number.isInteger(normalizedError.statusCode) && normalizedError.statusCode >= 400 && normalizedError.statusCode <= 499) {
    res.status(normalizedError.statusCode).json({
      success: false,
      error: normalizedError.message,
    });
    return;
  }
  
  // Don't expose internal errors
  res.status(500).json({
    success: false,
    error: 'An internal error occurred',
  });
}
