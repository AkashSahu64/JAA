CREATE TABLE "submission_verification_evidence" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "attemptId" TEXT,
  "provider" TEXT NOT NULL,
  "confirmationId" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "parserVersion" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "submission_verification_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "submission_verification_evidence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "submission_verification_evidence_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE
  ,CONSTRAINT "submission_verification_evidence_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "application_attempts"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "submission_verification_evidence_applicationId_evidenceHash_key"
  ON "submission_verification_evidence"("applicationId", "evidenceHash");
CREATE INDEX "submission_verification_evidence_userId_createdAt_idx"
  ON "submission_verification_evidence"("userId", "createdAt");
CREATE INDEX "submission_verification_evidence_applicationId_createdAt_idx"
  ON "submission_verification_evidence"("applicationId", "createdAt");
CREATE INDEX "submission_verification_evidence_attemptId_idx"
  ON "submission_verification_evidence"("attemptId");
