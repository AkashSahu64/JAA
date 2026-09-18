import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { decryptBackupBytes, encryptBackupBytes, validateBackupEncryptionKey } from './database-backup-crypto.mjs';
import { verifyBackupManifest, writeBackupManifest } from './database-integrity.mjs';

const docker = process.env.DOCKER_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker');
const container = process.env.POSTGRES_CONTAINER ?? 'job-application-agent-postgres-1';
const postgresPassword = process.env.POSTGRES_PASSWORD ?? 'jobagent-local';
const outputDir = process.env.BACKUP_DRILL_OUTPUT_DIR ?? join(process.env.TEMP ?? '.', 'jobagent-backup-restore-drill');
const key = process.env.BACKUP_ENCRYPTION_KEY;
const maxRestoreSeconds = process.env.RESTORE_DRILL_MAX_SECONDS === undefined ? undefined : Number(process.env.RESTORE_DRILL_MAX_SECONDS);
if (maxRestoreSeconds !== undefined && (!Number.isFinite(maxRestoreSeconds) || maxRestoreSeconds <= 0 || maxRestoreSeconds > 86_400)) throw new Error('RESTORE_DRILL_MAX_SECONDS must be between 0 and 86400');
validateBackupEncryptionKey(key);
mkdirSync(outputDir, { recursive: true });
const plainPath = join(outputDir, 'fixture.dump.plain');
const encryptedPath = join(outputDir, 'fixture.dump.enc');
const restoreDatabase = `jobagent_restore_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

function runDocker(args, input) {
  const result = spawnSync(docker, args, { input, encoding: input ? null : 'buffer', maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Docker command failed: ${result.error?.message ?? String(result.stderr ?? '').trim()}`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function sql(statement, database = 'postgres') {
  return runDocker(['exec', '-e', `PGPASSWORD=${postgresPassword}`, container, 'psql', '--no-password', '--username', 'jobagent', '--dbname', database, '--tuples-only', '--no-align', '--command', statement]).toString('utf8').trim();
}

let databaseCreated = false;
const startedAt = Date.now();
try {
  const dump = runDocker(['exec', '-e', `PGPASSWORD=${postgresPassword}`, container, 'pg_dump', '--format=custom', '--no-owner', '--username', 'jobagent', '--dbname', 'jobagent']);
  if (dump.length === 0) throw new Error('PostgreSQL dump is empty');
  writeFileSync(plainPath, dump, { mode: 0o600 });
  const encrypted = encryptBackupBytes(dump, key);
  writeFileSync(encryptedPath, encrypted, { mode: 0o600 });
  writeBackupManifest(encryptedPath);
  verifyBackupManifest(encryptedPath);
  const decrypted = decryptBackupBytes(readFileSync(encryptedPath), key);
  if (createHash('sha256').update(decrypted).digest('hex') !== createHash('sha256').update(dump).digest('hex')) throw new Error('Backup decryption checksum mismatch');

  sql(`CREATE DATABASE ${restoreDatabase}`);
  databaseCreated = true;
  runDocker(['exec', '-i', '-e', `PGPASSWORD=${postgresPassword}`, container, 'pg_restore', '--exit-on-error', '--no-owner', '--username', 'jobagent', '--dbname', restoreDatabase], decrypted);
  if (sql("SELECT to_regclass('public.jobs') IS NOT NULL", restoreDatabase) !== 't') throw new Error('Restored database schema verification failed');
  const sourceTables = sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'", 'jobagent');
  const restoredTables = sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'", restoreDatabase);
  if (!sourceTables || sourceTables !== restoredTables) throw new Error(`Restored table count mismatch: source=${sourceTables} restored=${restoredTables}`);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  if (maxRestoreSeconds !== undefined && elapsedSeconds > maxRestoreSeconds) throw new Error(`Restore rehearsal exceeded RESTORE_DRILL_MAX_SECONDS: ${elapsedSeconds.toFixed(3)}s > ${maxRestoreSeconds}s`);
  console.log(`Disposable destructive restore rehearsal passed: ${dump.length} bytes restored into ${restoreDatabase}; ${restoredTables} public tables verified in ${elapsedSeconds.toFixed(3)}s.`);
} finally {
  if (databaseCreated) {
    try { sql(`DROP DATABASE IF EXISTS ${restoreDatabase}`); } catch (error) { console.error(`Restore cleanup failed for ${restoreDatabase}: ${error.message}`); }
  }
  rmSync(plainPath, { force: true });
  rmSync(encryptedPath, { force: true });
  rmSync(`${encryptedPath}.sha256`, { force: true });
  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
}
