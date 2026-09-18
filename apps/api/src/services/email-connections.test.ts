import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  credentialFindFirst: vi.fn(),
  connectionUpsert: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@jobagent/database', () => ({
  withTenant: async (_userId: string, operation: (tx: unknown) => unknown) => operation({
    credentialRecord: { findFirst: mocks.credentialFindFirst },
    emailConnection: { upsert: mocks.connectionUpsert },
    auditLog: { create: mocks.auditCreate },
  }),
}));

import { grantEmailConsent, validateEmailConsentInput } from './email-connections';

describe('email consent boundary', () => {
  const valid = { userId: 'tenant-a', provider: 'GMAIL' as const, accountLabel: 'candidate@example.test', scopes: ['https://www.googleapis.com/auth/gmail.readonly'], credentialRef: 'vault:credential-1' };
  it('accepts bounded provider consent with an opaque credential reference', () => {
    expect(() => validateEmailConsentInput(valid)).not.toThrow();
  });
  it('rejects raw or malformed credential material', () => {
    expect(() => validateEmailConsentInput({ ...valid, credentialRef: 'ya29.raw-token/with-slash' })).toThrow('opaque reference');
  });
  it('rejects unsupported providers and invalid scopes', () => {
    expect(() => validateEmailConsentInput({ ...valid, provider: 'OUTLOOK' as never })).toThrow('Unsupported');
    expect(() => validateEmailConsentInput({ ...valid, scopes: [''] })).toThrow('scopes');
  });
  it('rejects broad or unknown direct-consent scopes for each OAuth provider', () => {
    expect(() => validateEmailConsentInput({ ...valid, scopes: ['https://mail.google.com/'] })).toThrow('approved read-mail');
    expect(() => validateEmailConsentInput({ ...valid, provider: 'MICROSOFT_GRAPH', scopes: ['Mail.ReadWrite'] })).toThrow('approved read-mail');
    expect(() => validateEmailConsentInput({ ...valid, provider: 'MICROSOFT_GRAPH', scopes: ['Mail.Read', 'Calendars.Read'] })).toThrow('approved read-mail');
  });
  it('rejects malformed consent objects without leaking a runtime TypeError', () => {
    expect(() => validateEmailConsentInput(undefined as never)).toThrow('consent input is invalid');
    expect(() => validateEmailConsentInput({ ...valid, userId: 7 as never })).toThrow('User');
  });

  it('rejects control characters in account labels and owner identities', () => {
    expect(() => validateEmailConsentInput({ ...valid, accountLabel: 'candidate@example.test\n' })).toThrow('Account label');
    expect(() => validateEmailConsentInput({ ...valid, userId: 'tenant-a\r' })).toThrow('User');
    expect(() => validateEmailConsentInput({ ...valid, scopes: ['readonly\n'] })).toThrow('scopes');
    expect(() => validateEmailConsentInput({ ...valid, credentialRef: 'credential-1\n' })).toThrow('opaque reference');
  });

  it('rejects a foreign or revoked durable credential before activating consent', async () => {
    mocks.credentialFindFirst.mockResolvedValue(null);
    await expect(grantEmailConsent(valid)).rejects.toThrow('does not belong');
    expect(mocks.connectionUpsert).not.toHaveBeenCalled();
  });

  it('allows an active owner-bound credential to activate consent', async () => {
    mocks.credentialFindFirst.mockResolvedValue({ id: 'credential-1' });
    mocks.connectionUpsert.mockResolvedValue({ id: 'connection-1' });
    await expect(grantEmailConsent(valid)).resolves.toMatchObject({ id: 'connection-1' });
    expect(mocks.connectionUpsert).toHaveBeenCalledOnce();
    expect(mocks.auditCreate).toHaveBeenCalledOnce();
  });
});
