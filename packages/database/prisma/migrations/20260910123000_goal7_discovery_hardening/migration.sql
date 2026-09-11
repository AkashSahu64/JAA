-- Harden discovery ownership/source identity and duplicate provenance.
-- This migration is additive because 20260910120000_goal7_discovery_persistence
-- may already be deployed.

-- A composite foreign key requires a matching parent unique constraint. It also
-- serializes first-child insertion against concurrent parent identity updates.
ALTER TABLE "job_discovery_runs"
  ADD CONSTRAINT "job_discovery_runs_id_userId_source_sourceAccount_key"
  UNIQUE ("id", "userId", "source", "sourceAccount");

ALTER TABLE "job_discovery_items"
  DROP CONSTRAINT "job_discovery_items_runId_fkey",
  ADD CONSTRAINT "job_discovery_items_runId_userId_source_sourceAccount_fkey"
    FOREIGN KEY ("runId", "userId", "source", "sourceAccount")
    REFERENCES "job_discovery_runs"("id", "userId", "source", "sourceAccount")
    ON DELETE CASCADE ON UPDATE NO ACTION;

-- Replacing the old permissive check validates all existing rows immediately;
-- deployment fails rather than preserving incomplete duplicate provenance.
ALTER TABLE "job_discovery_items"
  DROP CONSTRAINT "job_discovery_items_jobId_fkey",
  DROP CONSTRAINT "job_discovery_items_duplicateOfJobId_fkey",
  DROP CONSTRAINT "job_discovery_items_job_consistency",
  ADD CONSTRAINT "job_discovery_items_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "jobs"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "job_discovery_items_duplicateOfJobId_fkey"
    FOREIGN KEY ("duplicateOfJobId") REFERENCES "jobs"("id")
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  ADD CONSTRAINT "job_discovery_items_job_consistency" CHECK (
    ("status" = 'DUPLICATE') = ("jobId" IS NOT NULL AND "duplicateOfJobId" IS NOT NULL)
    AND ("status" <> 'DUPLICATE' OR "jobId" = "duplicateOfJobId")
    AND ("jobId" IS NULL OR "status" IN ('UPSERTED', 'DUPLICATE'))
    AND ("duplicateOfJobId" IS NULL OR "status" = 'DUPLICATE')
  );
