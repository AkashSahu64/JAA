import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from '@jobagent/security';
import { withTenant } from '@jobagent/database';

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export interface CredentialRecordInput { userId: string; name: string; value: string; }

export function validateCredentialRecordInput(input: CredentialRecordInput): void {
  if (!input || typeof input.userId !== 'string' || hasControlCharacters(input.userId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.userId)) throw new Error('Credential owner is required');
  if (typeof input.name !== 'string' || hasControlCharacters(input.name) || !input.name.trim() || input.name.trim().length > 200) throw new Error('Credential name must be between 1 and 200 characters');
  if (typeof input.value !== 'string' || !input.value || input.value.length > 100_000) throw new Error('Credential value must be between 1 and 100000 characters');
}

export async function storeDurableCredential(input: CredentialRecordInput) {
  validateCredentialRecordInput(input);
  const name = input.name.trim();
  return withTenant(input.userId, async (tx) => {
    const record = await tx.credentialRecord.upsert({
      where: { userId_name: { userId: input.userId, name } },
      create: { id: randomUUID(), userId: input.userId, name, encryptedValue: encrypt(input.value), version: 1, revokedAt: null },
      update: { encryptedValue: encrypt(input.value), version: { increment: 1 }, revokedAt: null },
      select: { id: true, userId: true, name: true, version: true, revokedAt: true, createdAt: true, updatedAt: true },
    });
    await tx.auditLog.create({ data: { userId: input.userId, action: 'CREDENTIAL_STORED', resource: 'CredentialRecord', resourceId: record.id, details: { name, version: record.version, plaintextPersisted: false } } });
    return record;
  });
}

/** Internal worker boundary: returns a secret only to an authenticated trusted caller. */
export async function retrieveDurableCredential(userId: string, credentialId: string): Promise<string | null> {
  if (typeof userId !== 'string' || hasControlCharacters(userId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(userId)
    || typeof credentialId !== 'string' || hasControlCharacters(credentialId) || !credentialId.trim() || credentialId.length > 200) return null;
  return withTenant(userId, async (tx) => {
    const record = await tx.credentialRecord.findFirst({ where: { id: credentialId, userId, revokedAt: null }, select: { encryptedValue: true } });
    if (!record) return null;
    const refreshed = await tx.credentialRecord.updateMany({ where: { id: credentialId, userId, revokedAt: null }, data: { updatedAt: new Date() } });
    if (refreshed.count !== 1) return null;
    await tx.auditLog.create({ data: { userId, action: 'CREDENTIAL_ACCESSED', resource: 'CredentialRecord', resourceId: credentialId, details: { plaintextReturnedToTrustedWorker: true } } });
    return decrypt(record.encryptedValue);
  });
}

export async function revokeDurableCredential(userId: string, credentialId: string) {
  if (typeof userId !== 'string' || hasControlCharacters(userId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(userId)
    || typeof credentialId !== 'string' || hasControlCharacters(credentialId) || !credentialId.trim() || credentialId.length > 200) throw new Error('Credential identity is required');
  return withTenant(userId, async (tx) => {
    const revokedAt = new Date();
    const changed = await tx.credentialRecord.updateMany({ where: { id: credentialId, userId, revokedAt: null }, data: { revokedAt, encryptedValue: '' } });
    if (changed.count !== 1) throw new Error('Credential not found or already revoked');
    const dependentConnections = await tx.emailConnection.updateMany({
      where: { userId, credentialRef: credentialId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt, credentialRef: null },
    });
    await tx.auditLog.create({ data: { userId, action: 'CREDENTIAL_REVOKED', resource: 'CredentialRecord', resourceId: credentialId, details: { encryptedMaterialDeleted: true, dependentEmailConnectionsRevoked: dependentConnections.count } } });
    return tx.credentialRecord.findFirstOrThrow({ where: { id: credentialId, userId }, select: { id: true, name: true, version: true, revokedAt: true } });
  });
}
