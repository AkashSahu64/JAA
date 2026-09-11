import { Request, Response, NextFunction } from 'express';
import { verifyToken, JWTPayload } from '@jobagent/security';

export interface AuthenticatedRequest extends Request {
  user?: JWTPayload;
  file?: Express.Multer.File;
}

export function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }
  const [scheme, token, extra] = authHeader.trim().split(/\s+/);
  if (scheme !== 'Bearer' || !token || extra) {
    res.status(401).json({ success: false, error: 'Authentication required' });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}
