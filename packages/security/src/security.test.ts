import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialVault } from './credential-vault';
import { decrypt, encrypt } from './encryption';
import { isValidEmail, isValidUrl, maskSensitive, sanitizeFileName, sanitizeHtml, sanitizeInput } from './sanitize';

let originalKey: string | undefined;

beforeEach(() => {
  originalKey = process.env.ENCRYPTION_KEY;
  process.env.ENCRYPTION_KEY = 'a-test-encryption-key-with-at-least-32-characters';
});

afterEach(() => {
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe('authenticated encryption', () => {
  it.each(['sensitive text', '', 'Unicode: café 🔐'])('round-trips %j', plaintext => {
    expect(decrypt(encrypt(plaintext))).toBe(plaintext);
  });

  it('uses random salt and IV and detects tampering', () => {
    const first = encrypt('same value');
    const second = encrypt('same value');
    expect(first).not.toBe(second);

    const parts = first.split(':');
    parts[3] = (parts[3][0] === '0' ? '1' : '0') + parts[3].slice(1);
    expect(() => decrypt(parts.join(':'))).toThrow();
  });

  it('rejects malformed encodings and weak or absent keys', () => {
    expect(() => decrypt('not:valid:ciphertext')).toThrow('Invalid encrypted format');
    expect(() => decrypt(`${'z'.repeat(64)}:${'0'.repeat(32)}:${'0'.repeat(32)}:00`)).toThrow('Invalid encrypted format');
    process.env.ENCRYPTION_KEY = 'too-short';
    expect(() => encrypt('secret')).toThrow('at least 32 characters');
  });
});

describe('CredentialVault', () => {
  it('is disabled in production so process-local secrets cannot be used accidentally', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new CredentialVault()).toThrow('disabled in production');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('stores, lists, updates, retrieves, and deletes encrypted values', async () => {
    const vault = new CredentialVault();
    const id = await vault.store('tenant-a', '  API key  ', 'initial-secret');

    expect(await vault.retrieve('tenant-a', id)).toBe('initial-secret');
    expect(await vault.list('tenant-a')).toContainEqual(expect.objectContaining({ id, name: 'API key' }));
    await expect(vault.update('tenant-a', id, 'replacement-secret')).resolves.toBe(true);
    expect(await vault.retrieve('tenant-a', id)).toBe('replacement-secret');
    await expect(vault.delete('tenant-a', id)).resolves.toBe(true);
    await expect(vault.retrieve('tenant-a', id)).resolves.toBeNull();
  });

  it('validates names and values and reports missing records', async () => {
    const vault = new CredentialVault();
    await expect(vault.store('tenant-a', '   ', 'secret')).rejects.toThrow('Credential name');
    await expect(vault.store('tenant-a', 'name', '')).rejects.toThrow('Credential value');
    await expect(vault.update('tenant-a', 'missing', 'value')).resolves.toBe(false);
  });

  it('isolates credentials by owner', async () => {
    const vault = new CredentialVault();
    const id = await vault.store('tenant-a', 'api', 'secret');
    await expect(vault.retrieve('tenant-b', id)).resolves.toBeNull();
    await expect(vault.update('tenant-b', id, 'stolen')).resolves.toBe(false);
    await expect(vault.delete('tenant-b', id)).resolves.toBe(false);
    expect(await vault.list('tenant-b')).toHaveLength(0);
  });
});

describe('sanitizers and validators', () => {
  it('encodes HTML and normalizes untrusted text and filenames', () => {
    expect(sanitizeHtml(`<a title="x">Tom & Jerry's</a>`)).toBe('&lt;a title=&quot;x&quot;&gt;Tom &amp; Jerry&#x27;s&lt;/a&gt;');
    expect(sanitizeInput('  a\0b  ')).toBe('ab');
    expect(sanitizeInput('x'.repeat(10_001))).toHaveLength(10_000);
    expect(sanitizeFileName('../résumé 2026.pdf')).toBe('__r_sum__2026.pdf');
  });

  it('validates email and protocol allowlists', () => {
    expect(isValidEmail('person@example.com')).toBe(true);
    expect(isValidEmail('person@example')).toBe(false);
    expect(isValidUrl('https://example.com/path')).toBe(true);
    expect(isValidUrl('http://example.com')).toBe(false);
    expect(isValidUrl('http://example.com', ['http:'])).toBe(true);
    expect(isValidUrl('not a url')).toBe(false);
  });

  it('masks values safely for normal and invalid visibility counts', () => {
    expect(maskSensitive('abcdefghijkl', 4)).toBe('abcd********');
    expect(maskSensitive('abc', 4)).toBe('****');
    expect(maskSensitive('secret', -2)).toBe('******');
    expect(maskSensitive('secret', Number.NaN)).toBe('****');
  });
});
