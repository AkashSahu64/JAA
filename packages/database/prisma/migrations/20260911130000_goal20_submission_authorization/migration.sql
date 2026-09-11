-- Goal 20: immutable, user-authorized submission preflight evidence.
CREATE TABLE "submission_authorizations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "applicationVersion" INTEGER NOT NULL,
  "resumeVersionId" TEXT NOT NULL,
  "preflightEvidence" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AUTHORIZED',
  "authorizedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "submission_authorizations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "submission_authorizations"
  ADD CONSTRAINT "submission_authorizations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "submission_authorizations"
  ADD CONSTRAINT "submission_authorizations_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "submission_authorizations_userId_idempotencyKey_key"
  ON "submission_authorizations"("userId", "idempotencyKey");

CREATE INDEX "submission_authorizations_applicationId_status_expiresAt_idx"
  ON "submission_authorizations"("applicationId", "status", "expiresAt");

CREATE INDEX "submission_authorizations_userId_authorizedAt_idx"
  ON "submission_authorizations"("userId", "authorizedAt");
