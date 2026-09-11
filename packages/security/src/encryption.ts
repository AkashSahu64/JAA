import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;

function getKey(salt: Buffer | string): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY environment variable must be at least 32 characters');
  }
  return scryptSync(key, salt, 32);
}

export function encrypt(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = getKey(salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const tag = cipher.getAuthTag();
  
  return [
    salt.toString('hex'),
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted
  ].join(':');
}

export function decrypt(ciphertext: string): string {
  const [saltHex, ivHex, tagHex, encrypted, ...extra] = ciphertext.split(':');

  if (!saltHex || !ivHex || !tagHex || encrypted === undefined || extra.length > 0) {
    throw new Error('Invalid encrypted format');
  }

  const hexPattern = /^[0-9a-f]*$/i;
  if (![saltHex, ivHex, tagHex, encrypted].every(part => hexPattern.test(part)) || encrypted.length % 2 !== 0) {
    throw new Error('Invalid encrypted format');
  }

  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const key = getKey(salt);

  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) {
    throw new Error('Invalid encrypted format');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}
