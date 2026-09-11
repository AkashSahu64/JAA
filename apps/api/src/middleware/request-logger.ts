import { Request, Response, NextFunction } from 'express';

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const requestPath = req.originalUrl.split('?')[0];
    const logLine = `${req.method} ${requestPath} ${res.statusCode} ${duration}ms`;
    
    if (res.statusCode >= 400) {
      console.error(`[ERROR] ${logLine}`);
    } else {
      console.log(`[REQ] ${logLine}`);
    }
  });
  
  next();
}
