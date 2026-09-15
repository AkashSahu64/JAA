import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

export function sha256File(path) {
  assertRegularBackupFile(path);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function assertRegularBackupFile(path, label = 'Backup') {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error(`${label} file is required`);
  }
  if (!stat.isFile() || stat.size === 0) throw new Error(`${label} file must be a non-empty regular file`);
}

export function writeBackupManifest(backupPath) {
  const digest = sha256File(backupPath);
  const manifestPath = `${backupPath}.sha256`;
  writeFileSync(manifestPath, `${digest}  ${basename(backupPath)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { manifestPath, digest };
}

export function verifyBackupManifest(backupPath) {
  assertRegularBackupFile(backupPath);
  assertRegularBackupFile(`${backupPath}.sha256`, 'Backup checksum manifest');
  const manifest = readFileSync(`${backupPath}.sha256`, 'utf8').trim();
  const expected = manifest.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
  if (!expected || expected[2] !== basename(backupPath)) throw new Error('Backup checksum manifest is invalid');
  const actual = sha256File(backupPath);
  if (actual !== expected[1].toLowerCase()) throw new Error('Backup checksum mismatch');
  return actual;
}
