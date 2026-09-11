import { prisma } from '@jobagent/database';
import type { DocumentStorage } from './document-storage';

export interface DocumentRetentionResult {
  deleted: number;
  failedObjectIds: string[];
}

/** Removes expired, non-held private objects and retains a deletion audit marker. */
export async function purgeExpiredDocuments(storage: Pick<DocumentStorage, 'delete'>, now = new Date()): Promise<DocumentRetentionResult> {
  const expired = await prisma.objectMetadata.findMany({
    where: { expiresAt: { lte: now }, deletedAt: null, legalHold: false },
    select: { id: true, bucket: true, objectKey: true, versionId: true },
  });
  const failedObjectIds: string[] = [];
  let deleted = 0;
  for (const object of expired) {
    try {
      await storage.delete(object);
      await prisma.objectMetadata.update({ where: { id: object.id }, data: { deletedAt: now } });
      deleted += 1;
    } catch {
      failedObjectIds.push(object.id);
    }
  }
  return { deleted, failedObjectIds };
}
