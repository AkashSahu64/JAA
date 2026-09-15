import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { verifyBackupManifest } from './database-integrity.mjs';
import { decryptBackupFile } from './database-backup-crypto.mjs';
import { databaseClientEnvironment, parseDatabaseConnectionUrl, selectDatabaseUrl } from './database-connection.mjs';

const backup = process.argv[2];
if (!backup || !existsSync(backup)) throw new Error('An existing backup file path is required');
if (!existsSync(`${backup}.sha256`)) throw new Error('A matching backup checksum manifest is required');
verifyBackupManifest(backup);
if (process.env.CONFIRM_DATABASE_RESTORE !== 'YES') throw new Error('Set CONFIRM_DATABASE_RESTORE=YES to authorize destructive restore');
const databaseUrl = selectDatabaseUrl();
const { parsed } = parseDatabaseConnectionUrl(databaseUrl);
const env = databaseClientEnvironment(parsed);
const tempDir = mkdtempSync(join(process.env.TEMP || process.env.TMP || '.', 'jobagent-restore-'));
const plaintext = join(tempDir, 'database.dump');
try {
  decryptBackupFile(backup, plaintext);
  execFileSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--host', parsed.hostname, '--port', parsed.port || '5432', '--username', decodeURIComponent(parsed.username), '--dbname', parsed.pathname.slice(1), plaintext], { stdio: 'inherit', env });
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
console.log(`Database restore completed from ${backup}`);
