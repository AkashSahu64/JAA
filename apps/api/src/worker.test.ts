import { describe, expect, it } from 'vitest';
import { closeWorkerResources, validateWorkerRuntimeConfiguration } from './worker';

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

  it.each([
    ['SCHEDULER_INTERVAL_MS', '999'],
    ['NOTIFICATION_OUTBOX_INTERVAL_MS', '249'],
    ['NOTIFICATION_OUTBOX_BATCH_SIZE', '501'],
  ])('rejects malformed production runtime setting %s', (name, value) => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'redis://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', [name]: value };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow(name);
  });

  it.each([
    ['WORKER_CONCURRENCY', '101'],
    ['WORKER_RATE_LIMIT_MAX', '10001'],
    ['WORKER_RATE_LIMIT_DURATION_MS', '120001'],
  ])('rejects unbounded production worker setting %s', (name, value) => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'redis://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', [name]: value };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow(name);
  });

  it('rejects a worker shutdown timeout shorter than one second', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'redis://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', WORKER_SHUTDOWN_TIMEOUT_MS: '999' };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow('WORKER_SHUTDOWN_TIMEOUT_MS');
  });

  it('rejects an unbounded worker shutdown timeout', () => {
    const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db', DATABASE_ADMIN_URL: 'postgresql://admin', REDIS_URL: 'redis://redis', S3_DOCUMENT_BUCKET: 'private', DOCUMENT_SCANNER_COMMAND: 'clamscan', WORKER_SHUTDOWN_TIMEOUT_MS: '120001' };
    expect(() => validateWorkerRuntimeConfiguration(env)).toThrow('WORKER_SHUTDOWN_TIMEOUT_MS');
  });

  it('continues closing later resources after an earlier close failure', async () => {
    const closed: string[] = [];
    await expect(closeWorkerResources([
      async () => { closed.push('first'); throw new Error('first close failed'); },
      async () => { closed.push('second'); },
      async () => { closed.push('third'); throw new Error('later close failed'); },
    ])).rejects.toThrow('first close failed');
    expect(closed).toEqual(['first', 'second', 'third']);
  });

  it('supports an already-clean resource close sequence', async () => {
    const close = async () => undefined;
    await expect(closeWorkerResources([close, close])).resolves.toBeUndefined();
  });

  it('starts every close operation without waiting on an earlier resource', async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>(resolve => { releaseFirst = resolve; });
    const started: string[] = [];
    const closing = closeWorkerResources([
      async () => { started.push('first'); await first; },
      async () => { started.push('second'); },
    ]);
    await Promise.resolve();
    expect(started).toEqual(['first', 'second']);
    releaseFirst();
    await expect(closing).resolves.toBeUndefined();
  });

  it('bounds a hung resource while still closing its peers', async () => {
    const closed: string[] = [];
    await expect(closeWorkerResources([
      async () => new Promise<void>(() => undefined),
      async () => { closed.push('peer'); },
    ], 5)).rejects.toThrow('shutdown timeout');
    expect(closed).toEqual(['peer']);
  });
});
