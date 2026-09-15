import { withTenant } from '@jobagent/database';

export const EMAIL_PROVIDERS = ['GMAIL', 'MICROSOFT_GRAPH', 'IMAP'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];

export interface GrantEmailConsentInput {
  userId: string;
  provider: EmailProvider;
  accountLabel: string;
  scopes: string[];
  credentialRef?: string;
}

function bounded(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} is required and bounded`);
  if (Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error(`${name} is required and bounded`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${name} is required and bounded`);
  return normalized;
}

export function validateEmailConsentInput(input: GrantEmailConsentInput): void {
  if (!input || typeof input !== 'object') throw new Error('Email consent input is invalid');
  bounded(input.userId, 'User', 200);
  if (!EMAIL_PROVIDERS.includes(input.provider)) throw new Error('Unsupported email provider');
  bounded(input.accountLabel, 'Account label', 320);
  if (!Array.isArray(input.scopes) || input.scopes.length > 50 || input.scopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 200 || Array.from(scope).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) throw new Error('Invalid email scopes');
  if (input.credentialRef !== undefined && (Array.from(input.credentialRef).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.credentialRef.trim()))) throw new Error('Credential reference must be an opaque reference');
}

export async function grantEmailConsent(input: GrantEmailConsentInput) {
  validateEmailConsentInput(input);
  return withTenant(input.userId, async (tx) => {
    const db = tx as any;
    const credentialRef = input.credentialRef?.trim();
    if (credentialRef) {
      const credential = await db.credentialRecord.findFirst({
        where: { id: credentialRef, userId: input.userId, revokedAt: null },
        select: { id: true },
      });
      if (!credential) throw new Error('Credential reference does not belong to an active user credential');
    }
    const connection = await db.emailConnection.upsert({
      where: { userId_provider_accountLabel: { userId: input.userId, provider: input.provider, accountLabel: input.accountLabel.trim() } },
      create: { userId: input.userId, provider: input.provider, accountLabel: input.accountLabel.trim(), scopes: input.scopes.map(scope => scope.trim()), credentialRef, status: 'ACTIVE', revokedAt: null },
      update: { scopes: input.scopes.map(scope => scope.trim()), credentialRef, status: 'ACTIVE', revokedAt: null },
    });
    await db.auditLog.create({ data: { userId: input.userId, action: 'EMAIL_CONSENT_GRANTED', resource: 'EmailConnection', resourceId: connection.id, details: { provider: input.provider, accountLabel: input.accountLabel.trim(), scopes: input.scopes.map(scope => scope.trim()), credentialMaterialStored: false } } });
    return connection;
  });
}

export async function revokeEmailConsent(userId: string, connectionId: string) {
  bounded(userId, 'User', 200);
  bounded(connectionId, 'Connection', 200);
  return withTenant(userId, async (tx) => {
    const db = tx as any;
    const result = await db.emailConnection.updateMany({ where: { id: connectionId, userId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date(), credentialRef: null } });
    if (result.count !== 1) throw new Error('Email connection not found or already revoked');
    await db.auditLog.create({ data: { userId, action: 'EMAIL_CONSENT_REVOKED', resource: 'EmailConnection', resourceId: connectionId, details: { credentialMaterialDeleted: true } } });
    return db.emailConnection.findFirstOrThrow({ where: { id: connectionId, userId } });
  });
}
