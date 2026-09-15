export function validateRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): void {
  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer between 1 and 65535');
  if (env.NODE_ENV !== 'production') return;
  const required: Array<[string, string | undefined]> = [
    ['DATABASE_URL', env.DATABASE_URL],
    ['REDIS_URL', env.REDIS_URL],
    ['AI_API_KEY', env.AI_API_KEY],
    ['JWT_SECRET', env.JWT_SECRET],
    ['ENCRYPTION_KEY', env.ENCRYPTION_KEY],
    ['S3_DOCUMENT_BUCKET', env.S3_DOCUMENT_BUCKET],
    ['DOCUMENT_SCANNER_COMMAND', env.DOCUMENT_SCANNER_COMMAND],
    ['FRONTEND_URL', env.FRONTEND_URL],
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length) throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  if (env.JWT_SECRET!.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
  if (env.ENCRYPTION_KEY!.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters in production');
  const provider = (env.AI_PROVIDER || 'openai').trim().toLowerCase();
  if (provider !== 'openai') throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  try {
    const frontend = new URL(env.FRONTEND_URL!);
    if (frontend.protocol !== 'https:' || frontend.username || frontend.password || frontend.pathname !== '/' || frontend.search || frontend.hash) throw new Error('origin');
  } catch {
    throw new Error('FRONTEND_URL must be an HTTPS origin in production');
  }
  validateProductionDatabaseUrl(env.DATABASE_URL!);
  validateProductionRedisUrl(env.REDIS_URL!);
  if (env.S3_ENDPOINT?.trim()) validateProductionS3Endpoint(env.S3_ENDPOINT);
}

export function validateProductionS3Endpoint(value: string): void {
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('unsafe');
  } catch {
    throw new Error('S3_ENDPOINT must be an HTTPS endpoint without embedded credentials or query data in production');
  }
}

export function validateProductionDatabaseUrl(value: string): void {
  try {
    const database = new URL(value);
    if (database.protocol !== 'postgresql:' && database.protocol !== 'postgres:') throw new Error('protocol');
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(database.hostname);
    const sslMode = database.searchParams.get('sslmode');
    if (!localHost && !['require', 'verify-ca', 'verify-full'].includes(sslMode ?? '')) throw new Error('tls');
  } catch {
    throw new Error('DATABASE_URL must use TLS for non-local production databases');
  }
}

export function validateProductionRedisUrl(value: string): void {
  try {
    const redis = new URL(value);
    if (redis.protocol !== 'redis:' && redis.protocol !== 'rediss:') throw new Error('protocol');
    const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname);
    if (!localHost && redis.protocol !== 'rediss:') throw new Error('tls');
  } catch {
    throw new Error('REDIS_URL must use TLS for non-local production Redis');
  }
}
