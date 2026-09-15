export function encryptBackupBytes(plain: Buffer, keyValue?: string): Buffer;
export function validateBackupEncryptionKey(keyValue?: string): void;
export function decryptBackupBytes(envelope: Buffer, keyValue?: string): Buffer;
export function encryptBackupFile(inputPath: string, outputPath: string, keyValue?: string): void;
export function decryptBackupFile(inputPath: string, outputPath: string, keyValue?: string): void;
