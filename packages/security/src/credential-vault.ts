import { randomUUID } from 'node:crypto';
import { encrypt, decrypt } from './encryption';

export interface StoredCredential {
  id: string;
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
  async store(name: string, value: string): Promise<string> {
    validateCredential(name, value);
    const id = randomUUID();
    const normalizedName = name.trim();
    const encryptedValue = encrypt(value);
    
    credentialStore.set(id, {
      id,
      name: normalizedName,
      encryptedValue,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    return id;
  }
  
  async retrieve(id: string): Promise<string | null> {
    const credential = credentialStore.get(id);
    if (!credential) return null;
    
    credential.lastAccessedAt = new Date();
    return decrypt(credential.encryptedValue);
  }
  
  async update(id: string, value: string): Promise<boolean> {
    validateCredentialValue(value);
    const credential = credentialStore.get(id);
    if (!credential) return false;
    
    credential.encryptedValue = encrypt(value);
    credential.updatedAt = new Date();
    return true;
  }
  
  async delete(id: string): Promise<boolean> {
    return credentialStore.delete(id);
  }
  
  async list(): Promise<Array<{ id: string; name: string; createdAt: Date }>> {
    return Array.from(credentialStore.values()).map(c => ({
      id: c.id,
      name: c.name,
      createdAt: c.createdAt,
    }));
  }
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
