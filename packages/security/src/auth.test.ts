import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateRefreshToken,
  generateToken,
  hashPassword,
  verifyPassword,
  verifyRefreshToken,
  verifyToken,
} from './auth';

const payload = { userId: 'user-123', email: 'person@example.com' };
let originalSecret: string | undefined;

beforeEach(() => {
  originalSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-secret-that-is-long-enough';
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalSecret;
});

describe('password utilities', () => {
  it('hashes and verifies a password without retaining plaintext', async () => {
    const password = 'correct horse battery staple';
    const hash = await hashPassword(password);

    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('enforces the documented password boundaries', async () => {
    await expect(hashPassword('a'.repeat(11))).rejects.toThrow('at least 12');
    await expect(hashPassword('a'.repeat(1025))).rejects.toThrow('must not exceed 1024');
    await expect(verifyPassword('', 'not-a-hash')).resolves.toBe(false);
    await expect(verifyPassword('valid-length-password', 'not-a-hash')).resolves.toBe(false);
  });
});

describe('JWT utilities', () => {
  it('round-trips access and refresh tokens only through matching verifiers', () => {
    const access = generateToken(payload);
    const refresh = generateRefreshToken(payload);

    expect(verifyToken(access)).toEqual(payload);
    expect(verifyRefreshToken(refresh)).toEqual(payload);
    expect(() => verifyToken(refresh)).toThrow('Invalid token payload');
    expect(() => verifyRefreshToken(access)).toThrow('Invalid token payload');
  });

  it('adds token type, issuer, audience, and distinct expirations', () => {
    const access = jwt.decode(generateToken(payload)) as jwt.JwtPayload;
    const refresh = jwt.decode(generateRefreshToken(payload)) as jwt.JwtPayload;

    expect(access).toMatchObject({ ...payload, tokenType: 'access', iss: 'job-application-agent', aud: 'job-application-agent' });
    expect(refresh).toMatchObject({ ...payload, tokenType: 'refresh' });
    expect(refresh.exp! - refresh.iat!).toBe(7 * 24 * 60 * 60);
  });

  it('rejects malformed payloads, invalid signatures, and missing configuration', () => {
    expect(() => generateToken({ userId: ' ', email: payload.email })).toThrow('requires userId and email');
    expect(() => verifyToken(generateToken(payload).slice(0, -1) + 'x')).toThrow();
    delete process.env.JWT_SECRET;
    expect(() => generateToken(payload)).toThrow('JWT_SECRET environment variable is required');
  });
});
