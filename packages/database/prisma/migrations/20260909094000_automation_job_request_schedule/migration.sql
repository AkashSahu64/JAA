-- Preserve the creation request schedule independently from mutable retry timing.
ALTER TABLE "automation_jobs"
  ADD COLUMN "requestedAvailableAt" TIMESTAMP(3);
