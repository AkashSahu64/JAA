import { describe, expect, it } from 'vitest';
import { databaseClientEnvironment, parseDatabaseConnectionUrl, selectDatabaseUrl } from '../../../../scripts/database-connection.mjs';

describe('database operational connection boundary', () => {
  it('prefers the owner-scoped URL and propagates its TLS mode', () => {
    const env = { DATABASE_ADMIN_URL: 'postgresql://admin:secret@db.example/jobagent?sslmode=verify-full', DATABASE_URL: 'postgresql://app:secret@db.example/jobagent' };
    const { parsed } = parseDatabaseConnectionUrl(selectDatabaseUrl(env), 'production');
    expect(parsed.username).toBe('admin');
    expect(databaseClientEnvironment(parsed, {}).PGSSLMODE).toBe('verify-full');
  });

  it('rejects a non-local production target without explicit TLS', () => {
    expect(() => parseDatabaseConnectionUrl('postgresql://admin:secret@db.example/jobagent', 'production')).toThrow('must require TLS');
  });

  it('allows the documented development fallback', () => {
    expect(selectDatabaseUrl({ DATABASE_URL: 'postgresql://app:secret@localhost/jobagent' })).toContain('localhost');
  });
});
