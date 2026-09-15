ALTER TABLE "application_documents" ADD COLUMN "objectMetadataId" TEXT;

ALTER TABLE "application_documents"
  ADD CONSTRAINT "application_documents_objectMetadataId_fkey"
  FOREIGN KEY ("objectMetadataId") REFERENCES "object_metadata"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "application_documents_objectMetadataId_idx"
  ON "application_documents"("objectMetadataId");
