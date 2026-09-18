import { describe, expect, it } from 'vitest';
import { EMAIL_PROVIDERS } from '../services/email-connections';

const CONNECTION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7E]{16,128}$/;

function validSyncInput(connectionId: string, idempotencyKey: string): { connectionId: string; idempotencyKey: string } | null {
  if (typeof connectionId !== 'string' || !CONNECTION_ID_PATTERN.test(connectionId)) return null;
  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return null;
  return { connectionId, idempotencyKey };
}

describe('email connection sync boundary', () => {
  it('lists the supported mailbox providers', () => {
    expect(EMAIL_PROVIDERS).toEqual(['GMAIL', 'MICROSOFT_GRAPH', 'IMAP']);
  });

  it('accepts bounded connection identifiers and idempotency keys', () => {
    expect(validSyncInput('conn-1', 'a'.repeat(16))).toMatchObject({ connectionId: 'conn-1', idempotencyKey: 'a'.repeat(16) });
    expect(validSyncInput('conn_2', 'key-with-various!@#$%^&*()chars')).toMatchObject({ connectionId: 'conn_2' });
    expect(validSyncInput('a.b:c-d_e', 'x'.repeat(128))).toMatchObject({ connectionId: 'a.b:c-d_e', idempotencyKey: 'x'.repeat(128) });
  });

  it.each([
    ['conn-1\n', 'valid-key-12345678'],
    ['conn-1\r', 'valid-key-12345678'],
    ['con t-1', 'valid-key-12345678'],
    ['a'.repeat(129), 'valid-key-12345678'],
    [''],
    [null],
    [undefined],
  ])('rejects malformed connection identifiers: %p', (...args: unknown[]) => {
    expect(validSyncInput(args[0] as never, 'valid-key-12345678')).toBeNull();
  });

  it.each([
    ['conn-1', 'short-15-chars!'],
    ['conn-1', 'a'.repeat(129)],
    ['conn-1', 'has spaces in key'],
    ['conn-1', 'tab\tinkey'],
    ['conn-1', 'newline\ninkey'],
    ['conn-1', ''],
    ['conn-1', null],
    ['conn-1', undefined],
  ])('rejects malformed idempotency keys: %p', (...args: unknown[]) => {
    expect(validSyncInput('conn-1', args[1] as never)).toBeNull();
  });

  it('rejects control characters in either identifier', () => {
    expect(validSyncInput('conn\x00-1', 'valid-key-12345678')).toBeNull();
    expect(validSyncInput('conn-1', 'valid-key-12345678\x7f')).toBeNull();
  });
});
