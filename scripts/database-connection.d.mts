export function selectDatabaseUrl(env?: Record<string, string | undefined>): string;
export function parseDatabaseConnectionUrl(value: string, nodeEnv?: string): { parsed: URL; sslMode: string | null };
export function databaseClientEnvironment(parsed: URL, base?: Record<string, string | undefined>): Record<string, string | undefined>;
