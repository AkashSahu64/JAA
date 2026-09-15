import { describe, expect, it } from 'vitest';
import { validateWorkerRuntimeConfiguration } from './worker';

describe('worker runtime configuration', () => {
  it('allows test/development defaults', () => {
    expect(() => validateWorkerRuntimeConfiguration({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('requires durable production dependencies', () => {
    expect(() => validateWorkerRuntimeConfiguration({ NODE_ENV: 'production' })).toThrow('DATABASE_URL');
  });

  it('rejects invalid production Redis URLs', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'http://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan' };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow('REDIS_URL');
  });

  it('requires TLS for non-local production Redis and PostgreSQL', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db.internal/jobagent?sslmode=require', DATABASE_ADMIN_URL: 'postgresql://admin.internal/jobagent?sslmode=require', REDIS_URL: 'redis://redis.internal', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan' };
    expect(() => validateWorkerRuntimeConfiguration(base)).toThrow('REDIS_URL');
    expect(() => validateWorkerRuntimeConfiguration({ ...base, REDIS_URL: 'rediss://redis.internal' })).not.toThrow();
    expect(() => validateWorkerRuntimeConfiguration({ ...base, DATABASE_URL: 'postgresql://db.internal/jobagent', REDIS_URL: 'rediss://redis.internal' })).toThrow('DATABASE_URL');
  });

  it('requires TLS for the separate maintenance database connection', () => {
    const base = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db.internal/jobagent?sslmode=require', DATABASE_ADMIN_URL: 'postgresql://admin.internal/jobagent', REDIS_URL: 'rediss://redis.internal', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan' };
    expect(() => validateWorkerRuntimeConfiguration(base)).toThrow('DATABASE_URL');
  });

  it('rejects malformed production document-retention intervals', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'redis://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', DOCUMENT_RETENTION_INTERVAL_MS: 'not-a-duration' };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow('DOCUMENT_RETENTION_INTERVAL_MS');
  });
});
