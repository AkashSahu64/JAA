import { Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeStructuredLog } from '../observability/structured-log';
import { createHttpSpan, exportHttpSpan } from '../observability/telemetry';

export function normalizeCorrelationId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : randomUUID();
}

export function normalizeTraceParent(value: string | undefined): string {
  const match = value?.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  if (match && !/^0{32}$/.test(match[1]) && !/^0{16}$/.test(match[2])) return `00-${match[1].toLowerCase()}-${match[2].toLowerCase()}-${match[3].toLowerCase()}`;
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`;
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const correlationId = normalizeCorrelationId(req.header('x-correlation-id'));
  const traceParent = normalizeTraceParent(req.header('traceparent'));
  res.setHeader('x-correlation-id', correlationId);
  res.setHeader('traceparent', traceParent);
  
  res.on('finish', () => {
    const finishedAt = new Date();
    const duration = Date.now() - start;
    const requestPath = req.originalUrl.split('?')[0];
    const params = req.params as Record<string, unknown>;
    const identifier = (name: string): string | undefined => typeof params[name] === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(params[name] as string) ? params[name] as string : undefined;
    writeStructuredLog(res.statusCode >= 400 ? 'error' : 'info', {
      event: 'http.request', correlationId, traceId: traceParent.split('-')[1], method: req.method, path: requestPath,
      statusCode: res.statusCode, durationMs: duration,
      userId: (req as Request & { user?: { userId?: string } }).user?.userId,
      applicationId: identifier('applicationId') ?? identifier('id'),
      automationJobId: identifier('jobId'),
      provider: identifier('provider'),
    });
    void exportHttpSpan(createHttpSpan({ traceId: traceParent.split('-')[1], name: `${req.method} ${req.path}`, startAt: new Date(start), endAt: finishedAt, statusCode: res.statusCode, attributes: { 'http.method': req.method, 'http.status_code': res.statusCode, 'http.route': requestPath } }));
  });
  
  next();
}
