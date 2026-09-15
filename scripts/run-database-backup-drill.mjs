import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { decryptBackupBytes, encryptBackupBytes, validateBackupEncryptionKey } from './database-backup-crypto.mjs';
import { verifyBackupManifest, writeBackupManifest } from './database-integrity.mjs';

const docker = process.env.DOCKER_BIN ?? (process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker');
const container = process.env.POSTGRES_CONTAINER ?? 'job-application-agent-postgres-1';
const outputDir = process.env.BACKUP_DRILL_OUTPUT_DIR ?? join(process.env.TEMP ?? '.', 'jobagent-backup-drill');
const key = process.env.BACKUP_ENCRYPTION_KEY;
validateBackupEncryptionKey(key);
mkdirSync(outputDir, { recursive: true });
const plainPath = join(outputDir, 'fixture.dump.plain');
const encryptedPath = join(outputDir, 'fixture.dump.enc');

function runDocker(args, input) {
  const result = spawnSync(docker, args, { input, encoding: input ? null : 'buffer', maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Docker command failed: ${result.error?.message ?? String(result.stderr ?? '').trim()}`);
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

try {
  const dump = runDocker(['exec', '-e', 'PGPASSWORD=jobagent-local', container, 'pg_dump', '--format=custom', '--no-owner', '--username', 'jobagent', '--dbname', 'jobagent']);
  if (dump.length === 0) throw new Error('PostgreSQL dump is empty');
  writeFileSync(plainPath, dump, { mode: 0o600 });
  const encrypted = encryptBackupBytes(dump, key);
  writeFileSync(encryptedPath, encrypted, { mode: 0o600 });
  writeBackupManifest(encryptedPath);
  verifyBackupManifest(encryptedPath);
  const decrypted = decryptBackupBytes(readFileSync(encryptedPath), key);
  if (createHash('sha256').update(decrypted).digest('hex') !== createHash('sha256').update(dump).digest('hex')) throw new Error('Backup decryption checksum mismatch');
  runDocker(['exec', '-i', container, 'pg_restore', '--list'], decrypted);
  console.log(`Disposable backup drill passed: ${dump.length} bytes dumped, encrypted, checksummed, decrypted, and restore-readable.`);
} finally {
  rmSync(plainPath, { force: true });
  rmSync(encryptedPath, { force: true });
  rmSync(`${encryptedPath}.sha256`, { force: true });
  if (existsSync(outputDir)) rmSync(outputDir, { recursive: true, force: true });
}
