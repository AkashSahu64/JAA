import { mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assertRegularBackupFile, writeBackupManifest } from './database-integrity.mjs';
import { encryptBackupFile, validateBackupEncryptionKey } from './database-backup-crypto.mjs';
import { databaseClientEnvironment, parseDatabaseConnectionUrl, selectDatabaseUrl } from './database-connection.mjs';

const databaseUrl = selectDatabaseUrl();
const { parsed, sslMode } = parseDatabaseConnectionUrl(databaseUrl);
validateBackupEncryptionKey();
const outputDir = process.env.BACKUP_OUTPUT_DIR || './backups';
mkdirSync(outputDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const plainOutput = join(outputDir, `jobagent-${stamp}.dump.plain`);
const output = join(outputDir, `jobagent-${stamp}.dump.enc`);
const env = databaseClientEnvironment(parsed);
try {
  execFileSync('pg_dump', ['--format=custom', '--no-owner', '--file', plainOutput, '--host', parsed.hostname, '--port', parsed.port || '5432', '--username', decodeURIComponent(parsed.username), '--dbname', parsed.pathname.slice(1)], { stdio: 'inherit', env });
  assertRegularBackupFile(plainOutput);
  encryptBackupFile(plainOutput, output);
  assertRegularBackupFile(output);
} finally {
  rmSync(plainOutput, { force: true });
}
const manifest = writeBackupManifest(output);
console.log(`Database backup written to ${output} (SHA-256 ${manifest.digest})`);
