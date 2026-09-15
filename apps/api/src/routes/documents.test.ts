import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const tx = {
    $executeRaw: vi.fn(),
    resumeVersion: { findFirst: vi.fn() },
    resume: { findFirst: vi.fn() },
    application: { findFirst: vi.fn() },
    applicationDocument: { findFirst: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    objectMetadata: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  return { tx, objectMetadata: tx.objectMetadata, auditLog: tx.auditLog, storeArtifact: vi.fn(), delete: vi.fn(), signedDownloadUrlAuthorized: vi.fn(), deleteAuthorized: vi.fn(), persist: vi.fn(), attach: vi.fn(), approve: vi.fn(), approvePublic: vi.fn(), withTenant: vi.fn(async (_user: string, callback: (value: typeof tx) => unknown) => callback(tx)) };
});

vi.mock('@jobagent/database', () => ({ prisma: { objectMetadata: mocks.objectMetadata, auditLog: mocks.auditLog }, withTenant: mocks.withTenant }));
vi.mock('../middleware/auth', () => ({
  authenticate: (req: any, res: any, next: () => void) => {
    const match = /^Bearer tenant-(.+)$/.exec(req.headers.authorization ?? '');
    if (!match) return res.status(401).json({ success: false, error: 'Authentication required' });
    req.user = { userId: match[1] };
    next();
  },
}));
vi.mock('../services/document-storage', () => ({
  DocumentStorage: class {
    storeArtifact = mocks.storeArtifact;
    delete = mocks.delete;
    signedDownloadUrlAuthorized = mocks.signedDownloadUrlAuthorized;
    deleteAuthorized = mocks.deleteAuthorized;
  },
  DocumentStorageError: class extends Error {},
  persistDocumentMetadataInTransaction: mocks.persist,
  attachDocumentToApplicationInTransaction: mocks.attach,
  approveDocumentMetadata: mocks.approvePublic,
  approveDocumentMetadataInTransaction: mocks.approve,
}));

import { documentRoutes } from './documents';

describe('document artifact upload route', () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.tx.application.findFirst.mockResolvedValue({ id: 'application-1', resumeVersionId: 'resume-version-1' });
    mocks.tx.resumeVersion.findFirst.mockResolvedValue({ id: 'resume-version-1' });
    mocks.tx.applicationDocument.findFirst.mockResolvedValue(null);
    mocks.objectMetadata.findFirst.mockResolvedValue({ id: 'object-1', userId: 'user-1', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'a'.repeat(64), versionId: null, fileName: 'confirmation.png', mimeType: 'image/png', checksumSha256: 'a'.repeat(64), byteSize: BigInt(9), scanStatus: 'CLEAN', deletedAt: null });
    mocks.tx.applicationDocument.create.mockResolvedValue({ id: 'application-document-1' });
    mocks.persist.mockResolvedValue({ replayed: false, metadata: {
      id: 'object-1', kind: 'SCREENSHOT', fileName: 'confirmation.png', mimeType: 'image/png', byteSize: BigInt(9), checksumSha256: 'a'.repeat(64), scanStatus: 'CLEAN',
    } });
    mocks.attach.mockResolvedValue({ replayed: false, document: { id: 'application-document-1' } });
    mocks.approve.mockImplementation(async (_tx: unknown, userId: string, id: string) => ({ id, userId, kind: 'SCREENSHOT', fileName: 'confirmation.png', mimeType: 'image/png', byteSize: BigInt(9), checksumSha256: 'a'.repeat(64), scanStatus: 'CLEAN', approvalStatus: 'APPROVED', approvedAt: new Date(), approvedBy: userId }));
    mocks.approvePublic.mockResolvedValue({ id: 'object-1', approvalStatus: 'APPROVED', approvedAt: new Date('2026-09-15T00:00:00.000Z'), approvedBy: 'user-1' });
    mocks.storeArtifact.mockResolvedValue({ kind: 'SCREENSHOT', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'a'.repeat(64), fileName: 'confirmation.png', mimeType: 'image/png', byteSize: 9, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } });
    mocks.signedDownloadUrlAuthorized.mockResolvedValue('https://signed.example/download');
    mocks.deleteAuthorized.mockResolvedValue(undefined);
    const app = express();
    app.use('/api/documents', documentRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}/api/documents`;
  });

  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });

  it('stores and binds an approved screenshot without returning binary content', async () => {
    const form = new FormData();
    form.set('kind', 'SCREENSHOT');
    form.set('applicationId', 'application-1');
    form.set('document', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'confirmation.png');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { objectMetadataId: 'object-1', applicationDocumentId: 'application-document-1', kind: 'SCREENSHOT', scanStatus: 'CLEAN' } });
    expect(mocks.storeArtifact).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', kind: 'SCREENSHOT', fileName: 'confirmation.png', mimeType: 'image/png' }));
    expect(mocks.persist).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeVersionId: 'resume-version-1' }));
    expect(mocks.attach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: 'application-1', objectMetadataId: 'object-1', type: 'other', resumeVersionId: 'resume-version-1' }));
    expect(mocks.tx.$executeRaw).toHaveBeenCalledWith(expect.any(Array), expect.stringContaining('user-1:artifact:SCREENSHOT:'));
  });

  it('allows only the authenticated owner approval endpoint to approve a document', async () => {
    const response = await fetch(`${baseUrl}/object-1/approve`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { id: 'object-1', approvalStatus: 'APPROVED', approvedBy: 'user-1' } });
    expect(mocks.approvePublic).toHaveBeenCalledWith('user-1', 'object-1');
  });

  it('binds an uploaded cover letter as a cover-letter document type', async () => {
    mocks.storeArtifact.mockResolvedValueOnce({ kind: 'COVER_LETTER', bucket: 'private', objectKey: 'private/cover_letter/user-1/' + 'a'.repeat(64), fileName: 'cover.txt', mimeType: 'text/plain', byteSize: 9, checksumSha256: 'a'.repeat(64), encryptionKeyRef: 'S3_MANAGED', scanStatus: 'CLEAN', scanDetails: { engine: 'fixture', scannedAt: new Date().toISOString() } });
    mocks.persist.mockResolvedValueOnce({ replayed: false, metadata: { id: 'object-cover', kind: 'COVER_LETTER', fileName: 'cover.txt', mimeType: 'text/plain', byteSize: BigInt(9), checksumSha256: 'a'.repeat(64), scanStatus: 'CLEAN' } });
    const form = new FormData();
    form.set('kind', 'COVER_LETTER');
    form.set('applicationId', 'application-1');
    form.set('resumeVersionId', 'resume-version-1');
    form.set('document', new Blob(['cover letter'], { type: 'text/plain' }), 'cover.txt');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(201);
    expect(mocks.attach).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: 'application-1', type: 'cover_letter' }));
  });

  it('rejects an application cover letter without an exact resume-version binding before storage access', async () => {
    const form = new FormData();
    form.set('kind', 'COVER_LETTER');
    form.set('applicationId', 'application-1');
    form.set('document', new Blob(['cover letter'], { type: 'text/plain' }), 'cover.txt');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(400);
    expect(mocks.storeArtifact).not.toHaveBeenCalled();
  });

  it('rejects a cover letter bound to a different resume version before storage access', async () => {
    const form = new FormData();
    form.set('kind', 'COVER_LETTER');
    form.set('applicationId', 'application-1');
    form.set('resumeVersionId', 'resume-version-other');
    form.set('document', new Blob(['cover letter'], { type: 'text/plain' }), 'cover.txt');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(400);
    expect(mocks.storeArtifact).not.toHaveBeenCalled();
  });

  it('rejects evidence explicitly bound to a different resume version before storage access', async () => {
    const form = new FormData();
    form.set('kind', 'SCREENSHOT');
    form.set('applicationId', 'application-1');
    form.set('resumeVersionId', 'resume-version-other');
    form.set('document', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'confirmation.png');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(400);
    expect(mocks.storeArtifact).not.toHaveBeenCalled();
  });

  it('replays a duplicate immutable artifact reference without creating a second binding', async () => {
    mocks.persist.mockResolvedValueOnce({ replayed: true, metadata: {
      id: 'object-1', kind: 'SCREENSHOT', fileName: 'confirmation.png', mimeType: 'image/png', byteSize: BigInt(9), checksumSha256: 'a'.repeat(64), scanStatus: 'CLEAN',
    } });
    mocks.attach.mockResolvedValueOnce({ replayed: true, document: { id: 'application-document-1' } });
    mocks.tx.applicationDocument.findFirst.mockResolvedValueOnce({ id: 'application-document-1' });
    const form = new FormData();
    form.set('kind', 'SCREENSHOT');
    form.set('applicationId', 'application-1');
    form.set('document', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'confirmation.png');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { replayed: true, applicationDocumentId: 'application-document-1' } });
    expect(mocks.attach).toHaveBeenCalledOnce();
  });

  it('rejects evidence without an application binding before storage access', async () => {
    const form = new FormData();
    form.set('kind', 'RECEIPT');
    form.set('document', new Blob(['receipt'], { type: 'text/plain' }), 'receipt.txt');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(400);
    expect(mocks.storeArtifact).not.toHaveBeenCalled();
  });

  it('returns a short-lived signed URL only for clean owner-bound metadata', async () => {
    mocks.objectMetadata.findFirst.mockResolvedValueOnce({ userId: 'user-1', bucket: 'private', objectKey: 'private/screenshot/user-1/' + 'a'.repeat(64), versionId: null, fileName: 'confirmation.png', mimeType: 'image/png', checksumSha256: 'a'.repeat(64), byteSize: BigInt(9), scanStatus: 'CLEAN', deletedAt: null });
    const response = await fetch(`${baseUrl}/object-1/download-url`, { headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(200);
    expect(mocks.objectMetadata.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({ scanStatus: true, deletedAt: true, expiresAt: true }),
    }));
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { url: 'https://signed.example/download', expiresInSeconds: 300 } });
  });

  it('does not presign metadata owned by another tenant', async () => {
    mocks.objectMetadata.findFirst.mockResolvedValueOnce(null);
    const response = await fetch(`${baseUrl}/object-1/download-url`, { headers: { authorization: 'Bearer tenant-user-2' } });
    expect(response.status).toBe(404);
  });

  it('retains a shared immutable object when metadata persistence fails, then permits retry', async () => {
    mocks.persist.mockRejectedValueOnce(new Error('metadata commit unavailable'));
    const makeUpload = () => {
      const form = new FormData();
      form.set('kind', 'SCREENSHOT');
      form.set('applicationId', 'application-1');
      form.set('document', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'confirmation.png');
      return fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    };
    expect((await makeUpload()).status).toBe(500);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.attach).not.toHaveBeenCalled();
    expect((await makeUpload()).status).toBe(201);
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('does not delete a shared object or query an aborted transaction on attachment conflict', async () => {
    mocks.attach.mockRejectedValueOnce(Object.assign(new Error('unique constraint'), { code: 'P2002' }));
    const form = new FormData();
    form.set('kind', 'SCREENSHOT');
    form.set('applicationId', 'application-1');
    form.set('document', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'confirmation.png');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(500);
    expect(mocks.attach).toHaveBeenCalledOnce();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it('deletes an owner-bound object and records a tombstone audit event', async () => {
    const response = await fetch(`${baseUrl}/object-1`, { method: 'DELETE', headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(204);
    expect(mocks.deleteAuthorized).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: 'object-1' }));
    expect(mocks.objectMetadata.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'object-1', userId: 'user-1', deletedAt: null }, data: { deletedAt: expect.any(Date) } }));
    expect(mocks.auditLog.create).toHaveBeenCalledOnce();
  });

  it('keeps a concurrent owner delete idempotent without duplicating the audit event', async () => {
    mocks.objectMetadata.updateMany.mockResolvedValueOnce({ count: 0 });
    const response = await fetch(`${baseUrl}/object-1`, { method: 'DELETE', headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(204);
    expect(mocks.deleteAuthorized).toHaveBeenCalledWith('user-1', expect.objectContaining({ id: 'object-1' }));
    expect(mocks.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not record a tombstone when object deletion fails', async () => {
    mocks.deleteAuthorized.mockRejectedValueOnce(new Error('object store unavailable'));
    const response = await fetch(`${baseUrl}/object-1`, { method: 'DELETE', headers: { authorization: 'Bearer tenant-user-1' } });
    expect(response.status).toBe(500);
    expect(mocks.objectMetadata.update).not.toHaveBeenCalled();
    expect(mocks.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects oversized multipart documents before storage access', async () => {
    const form = new FormData();
    form.set('kind', 'COVER_LETTER');
    form.set('document', new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'text/plain' }), 'cover.txt');
    const response = await fetch(`${baseUrl}/upload`, { method: 'POST', headers: { authorization: 'Bearer tenant-user-1' }, body: form });
    expect(response.status).toBe(413);
    expect(mocks.storeArtifact).not.toHaveBeenCalled();
  });
});
