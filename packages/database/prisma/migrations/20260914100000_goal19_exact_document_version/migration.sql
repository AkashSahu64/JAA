ALTER TABLE "object_metadata" ADD COLUMN "resume_version_id" TEXT;

CREATE UNIQUE INDEX "object_metadata_resume_version_id_key" ON "object_metadata"("resume_version_id");

ALTER TABLE "object_metadata"
  ADD CONSTRAINT "object_metadata_resume_version_id_fkey"
  FOREIGN KEY ("resume_version_id") REFERENCES "resume_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
