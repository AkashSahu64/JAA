import { Router, Response } from 'express';
import multer from 'multer';
import { withTenant } from '@jobagent/database';
import { authenticate, AuthenticatedRequest } from '../middleware/auth';
import {
  DocumentStorage,
  DocumentStorageError,
  persistDocumentMetadataInTransaction,
  attachDocumentToApplicationInTransaction,
  approveDocumentMetadata,
  approveDocumentMetadataInTransaction,
  type DocumentArtifactKind,
} from '../services/document-storage';
import { logRouteError } from '../observability/structured-log';

const router = Router();
router.use(authenticate);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const uploadSingle = (req: AuthenticatedRequest, res: Response, next: () => void) => {
  upload.single('document')(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'document exceeds the 10 MB limit' });
    return res.status(400).json({ success: false, error: 'invalid multipart document upload' });
  });
};
const documentStorage = new DocumentStorage();
const kinds = new Set<DocumentArtifactKind>(['COVER_LETTER', 'APPLICATION_EVIDENCE', 'SCREENSHOT', 'RECEIPT']);

router.get('/:id/download-url', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const object = await withTenant(req.user!.userId, tx => tx.objectMetadata.findFirst({
      where: { id: req.params.id, userId: req.user!.userId, deletedAt: null, scanStatus: 'CLEAN', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
      select: { userId: true, bucket: true, objectKey: true, versionId: true, fileName: true, mimeType: true, checksumSha256: true, byteSize: true, encryptionKeyRef: true, scanStatus: true, deletedAt: true, expiresAt: true },
    }));
    if (!object) return res.status(404).json({ success: false, error: 'Document not found' });
    const url = await documentStorage.signedDownloadUrlAuthorized(req.user!.userId, object);
    return res.json({ success: true, data: { url, expiresInSeconds: 300 } });
  } catch (error) {
    logRouteError('document.download_url_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    if (error instanceof DocumentStorageError && error.code === 'INVALID_DOCUMENT') return res.status(404).json({ success: false, error: 'Document not found' });
    if (error instanceof DocumentStorageError) return res.status(503).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'Failed to prepare document download' });
  }
});

router.delete('/:id', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const object = await withTenant(req.user!.userId, tx => tx.objectMetadata.findFirst({
      where: { id: req.params.id, userId: req.user!.userId, deletedAt: null },
      select: { id: true, userId: true, bucket: true, objectKey: true, versionId: true, fileName: true, mimeType: true, checksumSha256: true, byteSize: true, encryptionKeyRef: true, scanStatus: true },
    }));
    if (!object) return res.status(404).json({ success: false, error: 'Document not found' });
    await documentStorage.deleteAuthorized(req.user!.userId, object);
    const deletedAt = new Date();
    await withTenant(req.user!.userId, async tx => {
      const tombstone = await tx.objectMetadata.updateMany({
        where: { id: object.id, userId: req.user!.userId, deletedAt: null },
        data: { deletedAt },
      });
      if (tombstone.count !== 1) return;
      await tx.auditLog.create({ data: { userId: req.user!.userId, action: 'DOCUMENT_DELETED_OWNER', resource: 'ObjectMetadata', resourceId: object.id, details: { checksumSha256: object.checksumSha256, deletedAt: deletedAt.toISOString() } } });
    });
    return res.status(204).send();
  } catch (error) {
    logRouteError('document.delete_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    if (error instanceof DocumentStorageError && error.code === 'INVALID_DOCUMENT') return res.status(404).json({ success: false, error: 'Document not found' });
    if (error instanceof DocumentStorageError) return res.status(503).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'Failed to delete document' });
  }
});

router.post('/:id/approve', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const document = await approveDocumentMetadata(req.user!.userId, req.params.id);
    return res.json({ success: true, data: { id: document.id, approvalStatus: document.approvalStatus, approvedAt: document.approvedAt, approvedBy: document.approvedBy } });
  } catch (error) {
    logRouteError('document.approve_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    if (error instanceof DocumentStorageError) return res.status(error.code === 'INVALID_DOCUMENT' ? 404 : 503).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'Failed to approve document' });
  }
});

router.post('/upload', uploadSingle, async (req: AuthenticatedRequest, res: Response) => {
  const file = req.file;
  const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() as DocumentArtifactKind : undefined;
  const applicationId = typeof req.body?.applicationId === 'string' ? req.body.applicationId.trim() : undefined;
  const resumeVersionId = typeof req.body?.resumeVersionId === 'string' ? req.body.resumeVersionId.trim() : undefined;
  let boundResumeVersionId = resumeVersionId;
  if (!file || !kind || !kinds.has(kind)) return res.status(400).json({ success: false, error: 'document and an approved artifact kind are required' });
  if (['APPLICATION_EVIDENCE', 'SCREENSHOT', 'RECEIPT'].includes(kind) && !applicationId) return res.status(400).json({ success: false, error: 'applicationId is required for application evidence artifacts' });
  if (kind === 'COVER_LETTER' && applicationId && !resumeVersionId) return res.status(400).json({ success: false, error: 'resumeVersionId is required when attaching a cover letter to an application' });
  try {
    if (applicationId) {
      const application = await withTenant(req.user!.userId, tx => tx.application.findFirst({
        where: { id: applicationId, userId: req.user!.userId },
        select: { id: true, resumeVersionId: true },
      }));
      if (!application) throw new DocumentStorageError('INVALID_DOCUMENT', 'Application does not belong to the authenticated owner');
      if (resumeVersionId && application.resumeVersionId !== resumeVersionId) {
        throw new DocumentStorageError('INVALID_DOCUMENT', 'Application artifact must be bound to the application\'s exact resume version');
      }
      // Every artifact attached to an application is bound to the immutable
      // resume version selected for that application, including evidence and
      // receipts. The browser worker can therefore never receive an artifact
      // reference detached from the application version it is auditing.
      boundResumeVersionId = application.resumeVersionId;
    }
    const storedDocument = await documentStorage.storeArtifact({ userId: req.user!.userId, kind, fileName: file.originalname, mimeType: file.mimetype, buffer: file.buffer });
    const result = await withTenant(req.user!.userId, async tx => {
      // Serialize duplicate artifact attachment before the first read. Do not
      // recover a unique violation by querying an already-aborted transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${req.user!.userId}:artifact:${kind}:${storedDocument.checksumSha256}`}, 0))`;
      let metadata = await persistDocumentMetadataInTransaction(tx, {
        userId: req.user!.userId,
        stored: storedDocument,
        resumeVersionId: boundResumeVersionId,
        provenance: { source: 'AUTHENTICATED_ARTIFACT_UPLOAD', applicationId: applicationId ?? null, resumeVersionId: boundResumeVersionId ?? null },
      });
      if (!applicationId) return { metadata: metadata.metadata, applicationDocumentId: undefined, replayed: metadata.replayed };
      // Uploading and attaching an artifact to this authenticated application
      // is an explicit owner approval action. Persist that decision before the
      // application binding so lower-level attachment paths cannot bypass it.
      const approved = await approveDocumentMetadataInTransaction(tx, req.user!.userId, metadata.metadata.id);
      metadata = { ...metadata, metadata: approved };
      const documentType = kind === 'COVER_LETTER' ? 'cover_letter' : 'other';
      const attachment = await attachDocumentToApplicationInTransaction(tx, {
        userId: req.user!.userId,
        applicationId,
        resumeVersionId: boundResumeVersionId!,
        objectMetadataId: metadata.metadata.id,
        type: documentType,
      });
      return { metadata: metadata.metadata, applicationDocumentId: attachment.document.id, replayed: metadata.replayed || attachment.replayed };
    });
    return res.status(result.replayed ? 200 : 201).json({ success: true, data: { objectMetadataId: result.metadata.id, applicationDocumentId: result.applicationDocumentId, kind: result.metadata.kind, fileName: result.metadata.fileName, mimeType: result.metadata.mimeType, byteSize: result.metadata.byteSize.toString(), checksumSha256: result.metadata.checksumSha256, scanStatus: result.metadata.scanStatus, replayed: result.replayed } });
  } catch (error) {
    // The immutable object may belong to a successful concurrent upload. Keep
    // it private on failure; retries can reuse it after metadata recovery.
    logRouteError('document.upload_failure', error, { correlationId: req.get('x-correlation-id'), userId: req.user?.userId });
    if (error instanceof DocumentStorageError) return res.status(error.code === 'SCAN_UNAVAILABLE' || error.code === 'STORAGE_UNAVAILABLE' ? 503 : 400).json({ success: false, error: error.message });
    return res.status(500).json({ success: false, error: 'Failed to upload document artifact' });
  }
});

export { router as documentRoutes };
