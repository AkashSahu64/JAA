ALTER TABLE "object_metadata"
  ADD COLUMN "approval_status" TEXT NOT NULL DEFAULT 'UNAPPROVED',
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "approved_by" TEXT;

UPDATE "object_metadata"
SET "approval_status" = 'APPROVED',
    "approved_at" = "createdAt",
    "approved_by" = "userId"
WHERE "kind" = 'RESUME_APPROVED';

CREATE INDEX "object_metadata_userId_approvalStatus_idx"
ON "object_metadata"("userId", "approval_status");
