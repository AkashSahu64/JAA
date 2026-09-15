const TLS_MODES = new Set(['require', 'verify-ca', 'verify-full']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function selectDatabaseUrl(env = process.env) {
  const value = env.DATABASE_ADMIN_URL || env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_ADMIN_URL or DATABASE_URL is required');
  return value;
}

export function parseDatabaseConnectionUrl(value, nodeEnv = process.env.NODE_ENV) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE URL must be valid PostgreSQL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error('DATABASE URL must be PostgreSQL');
  const sslMode = parsed.searchParams.get('sslmode');
  if (nodeEnv === 'production' && !LOCAL_HOSTS.has(parsed.hostname) && !TLS_MODES.has(sslMode ?? '')) throw new Error('Production DATABASE_URL must require TLS');
  return { parsed, sslMode };
}

export function databaseClientEnvironment(parsed, base = process.env) {
  const sslMode = parsed.searchParams.get('sslmode');
  return { ...base, PGPASSWORD: decodeURIComponent(parsed.password), ...(sslMode ? { PGSSLMODE: sslMode } : {}) };
}
