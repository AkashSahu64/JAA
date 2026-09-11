import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { JwtPayload } from 'jsonwebtoken';

const SALT_ROUNDS = 12;
const JWT_ISSUER = 'job-application-agent';
const JWT_AUDIENCE = 'job-application-agent';
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_MAX_LENGTH = 1024;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET environment variable is required');
  return secret;
}

export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!password || password.length > PASSWORD_MAX_LENGTH || !hash) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

export interface JWTPayload {
  userId: string;
  email: string;
}

type TokenType = 'access' | 'refresh';

export function generateToken(payload: JWTPayload, expiresIn: jwt.SignOptions['expiresIn'] = '24h'): string {
  return signToken(payload, 'access', expiresIn);
}

export function verifyToken(token: string): JWTPayload {
  return verifyTypedToken(token, 'access');
}

export function generateRefreshToken(payload: JWTPayload): string {
  return signToken(payload, 'refresh', '7d');
}

export function verifyRefreshToken(token: string): JWTPayload {
  return verifyTypedToken(token, 'refresh');
}

function signToken(payload: JWTPayload, tokenType: TokenType, expiresIn: jwt.SignOptions['expiresIn']): string {
  validatePayload(payload);
  return jwt.sign({ ...payload, tokenType }, getJwtSecret(), {
    expiresIn,
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

function verifyTypedToken(token: string, expectedType: TokenType): JWTPayload {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
  if (typeof payload === 'string' || !isJwtPayload(payload) || payload.tokenType !== expectedType) {
    throw new jwt.JsonWebTokenError('Invalid token payload');
  }
  return { userId: payload.userId, email: payload.email };
}

function validatePassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must not exceed ${PASSWORD_MAX_LENGTH} characters`);
  }
}

function validatePayload(payload: JWTPayload): void {
  if (!payload.userId.trim() || !payload.email.trim()) {
    throw new Error('JWT payload requires userId and email');
  }
}

function isJwtPayload(payload: JwtPayload): payload is JwtPayload & JWTPayload {
  return typeof payload.userId === 'string' && typeof payload.email === 'string';
}
