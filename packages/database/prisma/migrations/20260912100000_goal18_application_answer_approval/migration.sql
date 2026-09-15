-- Goal 18: preserve explicit approver and optimistic answer revision for application answers.
ALTER TABLE "application_answers"
  ADD COLUMN "approvedBy" TEXT,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "application_answers"
  ADD CONSTRAINT "application_answers_version_positive" CHECK ("version" > 0);

CREATE INDEX "application_answers_userId_approvedBy_idx"
  ON "application_answers"("userId", "approvedBy");
