import { describe, expect, it } from 'vitest';
import {
  DocumentStorage,
  DocumentStorageError,
  type DocumentScanner,
  validateDocumentUpload,
} from './document-storage';

const cleanScanner: DocumentScanner = { scan: async () => ({ status: 'CLEAN', engine: 'fixture' }) };
const pdf = Buffer.from('%PDF-1.7\nfixture');

describe('document storage validation', () => {
  it('accepts matching PDF bytes and produces a stable SHA-256 checksum', () => {
    expect(validateDocumentUpload({ buffer: pdf, fileName: 'resume.pdf', mimeType: 'application/pdf' }))
      .toEqual({ mimeType: 'application/pdf', checksumSha256: 'f581fc87f30296eff11777c3ce1b9a8b7077071ad8abedfcba317fef0c807224' });
  });

  it.each([
    [{ buffer: Buffer.from('not a PDF'), fileName: 'resume.pdf', mimeType: 'application/pdf' }],
    [{ buffer: pdf, fileName: 'resume.pdf', mimeType: 'text/plain' }],
    [{ buffer: Buffer.from('safe\0text'), fileName: 'resume.txt', mimeType: 'text/plain' }],
  ])('rejects forged type evidence', input => {
    expect(() => validateDocumentUpload(input)).toThrow(DocumentStorageError);
  });

  it('fails closed when malware scanning is unavailable', async () => {
    const scanner: DocumentScanner = { scan: async () => ({ status: 'ERROR', engine: 'fixture' }) };
    const storage = new DocumentStorage(scanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'SCAN_UNAVAILABLE' } satisfies Partial<DocumentStorageError>);
  });

  it('fails closed when malware is detected', async () => {
    const scanner: DocumentScanner = { scan: async () => ({ status: 'INFECTED', engine: 'fixture' }) };
    const storage = new DocumentStorage(scanner, () => { throw new Error('storage must not be used'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'MALWARE_DETECTED' } satisfies Partial<DocumentStorageError>);
  });

  it('does not need storage configuration until an upload passes scanning', async () => {
    const storage = new DocumentStorage(cleanScanner, () => { throw new DocumentStorageError('STORAGE_UNAVAILABLE', 'Private document storage is not configured'); });
    await expect(storage.storeResume({ userId: 'user-1', fileName: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' } satisfies Partial<DocumentStorageError>);
  });
});
