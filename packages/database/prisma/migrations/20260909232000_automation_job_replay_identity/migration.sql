ALTER TABLE "automation_jobs"
  ADD COLUMN "replayOfId" TEXT;

CREATE UNIQUE INDEX "automation_jobs_replayOfId_key"
  ON "automation_jobs"("replayOfId");

ALTER TABLE "automation_jobs"
  ADD CONSTRAINT "automation_jobs_replayOfId_fkey"
  FOREIGN KEY ("replayOfId") REFERENCES "automation_jobs"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
