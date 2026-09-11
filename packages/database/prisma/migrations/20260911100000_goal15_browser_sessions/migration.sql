-- Goal 15: make browser-session references tenant-idempotent and lifecycle constrained.
ALTER TABLE "browser_session_references"
  ADD COLUMN "initialUrl" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "correlationId" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "idempotencyKey" TEXT NOT NULL DEFAULT '';

UPDATE "browser_session_references"
SET "initialUrl" = 'https://' || "allowedHost" || '/',
    "correlationId" = 'browser-session:' || "id",
    "idempotencyKey" = 'legacy-browser-session:' || "id"
WHERE "initialUrl" = '' OR "correlationId" = '' OR "idempotencyKey" = '';

ALTER TABLE "browser_session_references"
  ALTER COLUMN "initialUrl" DROP DEFAULT,
  ALTER COLUMN "correlationId" DROP DEFAULT,
  ALTER COLUMN "idempotencyKey" DROP DEFAULT,
  ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

UPDATE "browser_session_references"
SET "status" = CASE
  WHEN "closedAt" IS NULL THEN 'ACTIVE'
  WHEN "status" = 'EXPIRED' THEN 'EXPIRED'
  ELSE 'CLOSED'
END;

ALTER TABLE "browser_session_references"
  ADD CONSTRAINT "browser_session_references_status_valid"
    CHECK ("status" IN ('ACTIVE', 'CLOSED', 'EXPIRED')),
  ADD CONSTRAINT "browser_session_references_lifecycle_consistency"
    CHECK (("status" = 'ACTIVE' AND "closedAt" IS NULL) OR ("status" IN ('CLOSED', 'EXPIRED') AND "closedAt" IS NOT NULL));

CREATE UNIQUE INDEX "browser_session_references_userId_idempotencyKey_key"
  ON "browser_session_references"("userId", "idempotencyKey");
CREATE INDEX "browser_session_references_applicationId_status_idx"
  ON "browser_session_references"("applicationId", "status");
