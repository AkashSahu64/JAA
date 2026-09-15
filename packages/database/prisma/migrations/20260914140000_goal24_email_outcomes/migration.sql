CREATE TABLE "email_outcomes" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "applicationId" TEXT,
  "messageId" TEXT NOT NULL,
  "senderHash" TEXT NOT NULL,
  "subjectHash" TEXT NOT NULL,
  "bodyHash" TEXT NOT NULL,
  "classification" TEXT NOT NULL,
  "confidence" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_outcomes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_outcomes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "email_outcomes_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "email_outcomes_userId_messageId_key" ON "email_outcomes"("userId", "messageId");
CREATE INDEX "email_outcomes_userId_classification_receivedAt_idx" ON "email_outcomes"("userId", "classification", "receivedAt");
CREATE INDEX "email_outcomes_applicationId_receivedAt_idx" ON "email_outcomes"("applicationId", "receivedAt");
