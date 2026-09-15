import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './encryption';

export interface StoredCredential {
  id: string;
  ownerId: string;
  name: string;
  encryptedValue: string;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt?: Date;
}

// This process-local store is suitable only for ephemeral credentials. Production callers
// should provide durable storage with access control and auditing.
const credentialStore = new Map<string, StoredCredential>();
const MAX_CREDENTIAL_NAME_LENGTH = 200;
const MAX_CREDENTIAL_VALUE_LENGTH = 100_000;

export class CredentialVault {
  constructor() {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CredentialVault is process-local and disabled in production; use durable tenant-scoped credentials');
    }
  }

  async store(ownerId: string, name: string, value: string): Promise<string> {
    validateOwner(ownerId);
    validateCredential(name, value);
    const id = randomUUID();
    const normalizedName = name.trim();
    const encryptedValue = encrypt(value);
    
    credentialStore.set(id, {
      id,
      ownerId,
      name: normalizedName,
      encryptedValue,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    return id;
  }
  
  async retrieve(ownerId: string, id: string): Promise<string | null> {
    validateOwner(ownerId);
    const credential = credentialStore.get(id);
    if (!credential || credential.ownerId !== ownerId) return null;
    
    credential.lastAccessedAt = new Date();
    return decrypt(credential.encryptedValue);
  }
  
  async update(ownerId: string, id: string, value: string): Promise<boolean> {
    validateOwner(ownerId);
    validateCredentialValue(value);
    const credential = credentialStore.get(id);
    if (!credential || credential.ownerId !== ownerId) return false;
    
    credential.encryptedValue = encrypt(value);
    credential.updatedAt = new Date();
    return true;
  }
  
  async delete(ownerId: string, id: string): Promise<boolean> {
    validateOwner(ownerId);
    const credential = credentialStore.get(id);
    if (!credential || credential.ownerId !== ownerId) return false;
    return credentialStore.delete(id);
  }
  
  async list(ownerId: string): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
    validateOwner(ownerId);
    return Array.from(credentialStore.values()).filter(c => c.ownerId === ownerId).map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
    }));
  }
}

function validateOwner(ownerId: string): void {
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(ownerId)) throw new Error('Credential owner is required');
}

function validateCredential(name: string, value: string): void {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > MAX_CREDENTIAL_NAME_LENGTH) {
    throw new Error(`Credential name must be between 1 and ${MAX_CREDENTIAL_NAME_LENGTH} characters`);
  }
  validateCredentialValue(value);
}

function validateCredentialValue(value: string): void {
  if (!value || value.length > MAX_CREDENTIAL_VALUE_LENGTH) {
    throw new Error(`Credential value must be between 1 and ${MAX_CREDENTIAL_VALUE_LENGTH} characters`);
  }
}
