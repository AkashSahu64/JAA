import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { writeStructuredLog } from '../observability/structured-log';

export function normalizeCorrelationId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const correlationId = normalizeCorrelationId(req.header('x-correlation-id'));
  res.setHeader('x-correlation-id', correlationId);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const requestPath = req.originalUrl.split('?')[0];
    const params = req.params as Record<string, unknown>;
    const identifier = (name: string): string | undefined => typeof params[name] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(params[name] as string) ? params[name] as string : undefined;
    writeStructuredLog(res.statusCode >= 400 ? 'error' : 'info', {
      event: 'http.request', correlationId, method: req.method, path: requestPath,
      statusCode: res.statusCode, durationMs: duration,
      userId: (req as Request & { user?: { userId?: string } }).user?.userId,
      applicationId: identifier('applicationId') ?? identifier('id'),
      automationJobId: identifier('jobId'),
      provider: identifier('provider'),
    });
  });
  
  next();
}
