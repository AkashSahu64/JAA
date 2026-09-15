import { describe, expect, it } from 'vitest';
import { closeHttpServer } from './server';
import { validateRuntimeConfiguration } from './runtime-config';

describe('HTTP shutdown', () => {
  it('resolves when the listener closes', async () => {
    const close = (callback: (error?: Error) => void) => { callback(); return {} as never; };
    await expect(closeHttpServer({ close }, 20)).resolves.toBeUndefined();
  });

  it('terminates connections and rejects when shutdown exceeds its bound', async () => {
    let terminated = false;
    const close = (_callback: (error?: Error) => void) => ({}) as never;
    await expect(closeHttpServer({ close, closeAllConnections: () => { terminated = true; } }, 5)).rejects.toThrow('shutdown timeout');
    expect(terminated).toBe(true);
  });
});

describe('runtime configuration', () => {
  it('accepts development configuration without production-only services', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'development', PORT: '3001' })).not.toThrow();
  });

  it('rejects invalid ports in every environment', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'test', PORT: '70000' })).toThrow('PORT');
  });

  it('fails closed when production secrets or private document controls are missing', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'production', PORT: '3001' })).toThrow('DATABASE_URL');
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://db', REDIS_URL: 'redis://localhost:6379', AI_API_KEY: 'ai-key', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', FRONTEND_URL: 'https://app.example' })).toThrow('DOCUMENT_SCANNER_COMMAND');
  });

  it('requires Redis for the production multi-instance event bridge', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://localhost/jobagent', AI_API_KEY: 'ai-key', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    expect(() => validateRuntimeConfiguration(base)).toThrow('REDIS_URL');
    expect(() => validateRuntimeConfiguration({ ...base, REDIS_URL: 'redis://redis.internal' })).toThrow('REDIS_URL');
    expect(() => validateRuntimeConfiguration({ ...base, REDIS_URL: 'rediss://redis.internal' })).not.toThrow();
  });

  it('rejects weak production secrets', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://db', REDIS_URL: 'redis://localhost:6379', AI_API_KEY: 'ai-key', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    expect(() => validateRuntimeConfiguration({ ...base, JWT_SECRET: 'short', ENCRYPTION_KEY: 'b'.repeat(32) })).toThrow('JWT_SECRET');
    expect(() => validateRuntimeConfiguration({ ...base, JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'short' })).toThrow('ENCRYPTION_KEY');
  });

  it('rejects production startup without the configured AI credential', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://localhost/jobagent', REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    expect(() => validateRuntimeConfiguration(base)).toThrow('AI_API_KEY');
  });

  it('rejects an AI provider that has no implemented production adapter', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://localhost/jobagent', REDIS_URL: 'redis://localhost:6379', AI_API_KEY: 'ai-key', AI_PROVIDER: 'anthropic', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    expect(() => validateRuntimeConfiguration(base)).toThrow('Unsupported AI_PROVIDER');
  });

  it('rejects an explicitly configured insecure production object-storage endpoint', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://db', REDIS_URL: 'redis://localhost:6379', AI_API_KEY: 'ai-key', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    const tlsBase = { ...base, DATABASE_URL: 'postgresql://db.internal/jobagent?sslmode=require' };
    expect(() => validateRuntimeConfiguration({ ...tlsBase, S3_ENDPOINT: 'http://minio.internal:9000' })).toThrow('S3_ENDPOINT');
    expect(() => validateRuntimeConfiguration({ ...tlsBase, S3_ENDPOINT: 'https://objects.internal' })).not.toThrow();
    expect(() => validateRuntimeConfiguration({ ...tlsBase, S3_ENDPOINT: 'https://user:password@objects.internal' })).toThrow('S3_ENDPOINT');
    expect(() => validateRuntimeConfiguration({ ...tlsBase, S3_ENDPOINT: 'https://objects.internal/?token=embedded' })).toThrow('S3_ENDPOINT');
  });

  it('requires TLS for non-local production PostgreSQL', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', AI_API_KEY: 'ai-key', REDIS_URL: 'redis://localhost:6379', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', FRONTEND_URL: 'https://app.example' };
    expect(() => validateRuntimeConfiguration({ ...base, DATABASE_URL: 'postgresql://db.internal/jobagent' })).toThrow('DATABASE_URL');
    expect(() => validateRuntimeConfiguration({ ...base, DATABASE_URL: 'postgresql://localhost/jobagent' })).not.toThrow();
  });

  it('requires an HTTPS origin for credentialed production CORS', () => {
    const base = { NODE_ENV: 'production', PORT: '3001', DATABASE_URL: 'postgresql://localhost/jobagent', REDIS_URL: 'redis://localhost:6379', AI_API_KEY: 'ai-key', JWT_SECRET: 'a'.repeat(32), ENCRYPTION_KEY: 'b'.repeat(32), S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan' };
    expect(() => validateRuntimeConfiguration({ ...base, FRONTEND_URL: 'http://app.example' })).toThrow('FRONTEND_URL');
    expect(() => validateRuntimeConfiguration({ ...base, FRONTEND_URL: 'https://app.example/path' })).toThrow('FRONTEND_URL');
    expect(() => validateRuntimeConfiguration({ ...base, FRONTEND_URL: 'https://app.example' })).not.toThrow();
  });
});
