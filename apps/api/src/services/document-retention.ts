import { withService } from '@jobagent/database';
import type { DocumentStorage } from './document-storage';

export interface DocumentRetentionResult {
  deleted: number;
  failedObjectIds: string[];
}

/** Removes expired, non-held private objects and retains a deletion audit marker. */
export async function purgeExpiredDocuments(storage: Pick<DocumentStorage, 'deleteAuthorized'>, now = new Date()): Promise<DocumentRetentionResult> {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Document retention time must be a valid Date');
  const failedObjectIds: string[] = [];
  let deleted = 0;
  await withService(async tx => {
    const expired = await tx.objectMetadata.findMany({
      where: { expiresAt: { lte: now }, deletedAt: null, legalHold: false },
      select: { id: true, userId: true, bucket: true, objectKey: true, versionId: true, fileName: true, mimeType: true, checksumSha256: true, byteSize: true, encryptionKeyRef: true },
    });
    for (const object of expired) {
      try {
        // Serialize retention workers per immutable object. The re-read after
        // the lock prevents a second worker from issuing duplicate delete and
        // audit operations after the first worker has committed its tombstone.
        const transaction = tx as typeof tx & { $executeRaw?: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };
        if (typeof transaction.$executeRaw === 'function') {
          await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`document-retention:${object.userId}:${object.id}`}, 0))`;
        }
        if (typeof tx.objectMetadata.findFirst === 'function') {
          const current = await tx.objectMetadata.findFirst({
            where: { id: object.id, userId: object.userId, expiresAt: { lte: now }, deletedAt: null, legalHold: false },
            select: { id: true },
          });
          if (!current) continue;
        }
        await storage.deleteAuthorized(object.userId, object);
        // An owner delete may win between the re-read and the object-store
        // delete. Only the worker that atomically claims the live row may
        // write the retention tombstone and its audit event.
        const tombstone = await tx.objectMetadata.updateMany({
          where: { id: object.id, userId: object.userId, deletedAt: null },
          data: { deletedAt: now },
        });
        if (tombstone.count !== 1) continue;
        await tx.auditLog.create({
          data: {
            userId: object.userId,
            action: 'DOCUMENT_DELETED_RETENTION',
            resource: 'ObjectMetadata',
            resourceId: object.id,
            details: { bucket: object.bucket, objectKey: object.objectKey, checksumSha256: object.checksumSha256, deletedAt: now.toISOString() },
          },
        });
        deleted += 1;
      } catch {
        failedObjectIds.push(object.id);
      }
    }
  });
  return { deleted, failedObjectIds };
}
