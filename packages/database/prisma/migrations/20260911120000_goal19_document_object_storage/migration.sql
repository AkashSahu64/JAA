-- Goal 19: attach private object evidence to resumes without retaining new binary uploads in PostgreSQL.
ALTER TABLE "object_metadata"
  ADD COLUMN "resumeId" TEXT;

ALTER TABLE "object_metadata"
  ADD CONSTRAINT "object_metadata_resumeId_fkey"
  FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "object_metadata_resumeId_key"
  ON "object_metadata"("resumeId");

CREATE INDEX "object_metadata_userId_scanStatus_deletedAt_idx"
  ON "object_metadata"("userId", "scanStatus", "deletedAt");
