import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const MAGIC = Buffer.from('JAG1');
const IV_BYTES = 12;
const TAG_BYTES = 16;

function encryptionKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('BACKUP_ENCRYPTION_KEY must be a 32-byte hexadecimal key');
  return Buffer.from(value, 'hex');
}

export function validateBackupEncryptionKey(value = process.env.BACKUP_ENCRYPTION_KEY) {
  encryptionKey(value);
}

export function encryptBackupBytes(plain, keyValue) {
  if (!Buffer.isBuffer(plain) || plain.length === 0) throw new Error('Backup plaintext must be non-empty');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(keyValue), iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBackupBytes(envelope, keyValue) {
  if (!Buffer.isBuffer(envelope) || envelope.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !envelope.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Encrypted backup envelope is invalid');
  const ivStart = MAGIC.length;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(keyValue), envelope.subarray(ivStart, tagStart));
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
  return Buffer.concat([decipher.update(envelope.subarray(ciphertextStart)), decipher.final()]);
}

export function encryptBackupFile(inputPath, outputPath, keyValue) { writeFileSync(outputPath, encryptBackupBytes(readFileSync(inputPath), keyValue), { mode: 0o600 }); }
export function decryptBackupFile(inputPath, outputPath, keyValue) { writeFileSync(outputPath, decryptBackupBytes(readFileSync(inputPath), keyValue), { mode: 0o600 }); }
