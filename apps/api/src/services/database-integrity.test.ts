import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertRegularBackupFile, sha256File, verifyBackupManifest, writeBackupManifest } from '../../../../scripts/database-integrity.mjs';
import { decryptBackupBytes, encryptBackupBytes, validateBackupEncryptionKey } from '../../../../scripts/database-backup-crypto.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('database backup integrity', () => {
  it('writes and verifies a SHA-256 manifest for the exact dump artifact', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jobagent-backup-')); directories.push(directory);
    const backup = join(directory, 'database.dump');
    writeFileSync(backup, 'deterministic dump bytes');
    const result = writeBackupManifest(backup);
    expect(result.digest).toBe(sha256File(backup));
    expect(verifyBackupManifest(backup)).toBe(result.digest);
    expect(readFileSync(`${backup}.sha256`, 'utf8')).toContain('database.dump');
  });

  it('fails closed when the dump is tampered after manifest creation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jobagent-backup-')); directories.push(directory);
    const backup = join(directory, 'database.dump');
    writeFileSync(backup, 'original bytes');
    writeBackupManifest(backup);
    writeFileSync(backup, 'tampered bytes');
    expect(() => verifyBackupManifest(backup)).toThrow('checksum mismatch');
  });

  it('rejects empty, directory, and symlink artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jobagent-backup-')); directories.push(directory);
    const empty = join(directory, 'empty.dump');
    writeFileSync(empty, '');
    expect(() => assertRegularBackupFile(empty)).toThrow('non-empty regular file');
    expect(() => assertRegularBackupFile(directory)).toThrow('non-empty regular file');
    const symlink = join(directory, 'link.dump');
    try {
      symlinkSync(empty, symlink);
      expect(() => assertRegularBackupFile(symlink)).toThrow('regular file');
    } catch (error) {
      if (error instanceof Error && !error.message.includes('EPERM')) throw error;
    }
  });

  it('round-trips an authenticated encrypted backup envelope and rejects tampering', () => {
    const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const plain = Buffer.from('custom-format dump bytes');
    const encrypted = encryptBackupBytes(plain, key);
    expect(decryptBackupBytes(encrypted, key)).toEqual(plain);
    encrypted[encrypted.length - 1] ^= 1;
    expect(() => decryptBackupBytes(encrypted, key)).toThrow();
    expect(() => validateBackupEncryptionKey('not-a-key')).toThrow('32-byte hexadecimal key');
  });
});
