-- Goal 14: make human-verification requests durable, tenant-idempotent, and safely resumable.
ALTER TABLE "human_verifications"
  ADD COLUMN "resumeToStatus" "ApplicationStatus" NOT NULL DEFAULT 'FORM_FILLED',
  ADD COLUMN "correlationId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "idempotencyKey" TEXT NOT NULL DEFAULT '';

UPDATE "human_verifications"
SET "correlationId" = 'human-verification:' || "id",
    "idempotencyKey" = 'legacy-human-verification:' || "id"
WHERE "correlationId" = '' OR "idempotencyKey" = '';

UPDATE "human_verifications"
SET "status" = 'EXPIRED',
    "resolvedAt" = COALESCE("resolvedAt", "updatedAt"),
    "resolution" = COALESCE("resolution", '{"legacyRecord":true,"credentialMaterialStored":false}'::jsonb)
WHERE "status" NOT IN ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED');

WITH duplicate_pending AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "applicationId" ORDER BY "createdAt" DESC, "id" DESC
  ) AS row_number
  FROM "human_verifications"
  WHERE "status" = 'PENDING'
)
UPDATE "human_verifications" verification
SET "status" = 'EXPIRED',
    "resolvedAt" = verification."updatedAt",
    "resolution" = '{"legacyRecord":true,"credentialMaterialStored":false}'::jsonb
FROM duplicate_pending
WHERE verification."id" = duplicate_pending."id"
  AND duplicate_pending.row_number > 1;

UPDATE "human_verifications"
SET "resolvedAt" = COALESCE("resolvedAt", "updatedAt"),
    "resolution" = COALESCE("resolution", '{"legacyRecord":true,"credentialMaterialStored":false}'::jsonb)
WHERE "status" IN ('RESOLVED', 'EXPIRED', 'CANCELLED');

ALTER TABLE "human_verifications"
  ADD CONSTRAINT "human_verifications_type_valid"
    CHECK ("type" IN ('CAPTCHA', 'MFA', 'ANTI_BOT', 'AUTH')),
  ADD CONSTRAINT "human_verifications_status_valid"
    CHECK ("status" IN ('PENDING', 'RESOLVED', 'EXPIRED', 'CANCELLED')),
  ADD CONSTRAINT "human_verifications_resume_status_valid"
    CHECK ("resumeToStatus" IN ('FORM_FILLED', 'READY_TO_SUBMIT')),
  ADD CONSTRAINT "human_verifications_resolution_consistency"
    CHECK (
      ("status" = 'PENDING' AND "resolvedAt" IS NULL AND "resolution" IS NULL)
      OR ("status" IN ('RESOLVED', 'EXPIRED', 'CANCELLED') AND "resolvedAt" IS NOT NULL AND "resolution" IS NOT NULL)
    );

CREATE UNIQUE INDEX "human_verifications_userId_idempotencyKey_key"
  ON "human_verifications"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "human_verifications_one_pending_per_application"
  ON "human_verifications"("applicationId")
  WHERE "status" = 'PENDING';
