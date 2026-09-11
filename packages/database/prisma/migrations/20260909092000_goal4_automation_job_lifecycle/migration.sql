-- Enforce an exact lease/terminal lifecycle for durable automation jobs.
ALTER TABLE "automation_jobs"
  DROP CONSTRAINT "automation_jobs_lease_consistency";

ALTER TABLE "automation_jobs"
  ADD CONSTRAINT "automation_jobs_lease_consistency"
    CHECK (
      ((status = 'LEASED') = ("leaseOwner" IS NOT NULL))
      AND (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL))
    ),
  ADD CONSTRAINT "automation_jobs_terminal_consistency"
    CHECK (
      ((status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER')) = ("completedAt" IS NOT NULL))
      AND ((status = 'CANCELLED') = ("cancelledAt" IS NOT NULL))
    );

DROP INDEX "automation_jobs_status_availableAt_priority_idx";
CREATE INDEX "automation_jobs_claim_ready_idx"
  ON "automation_jobs"(status, "availableAt", priority DESC, "createdAt");

DROP POLICY "automation_jobs_tenant_isolation" ON "automation_jobs";
CREATE POLICY "automation_jobs_tenant_isolation" ON "automation_jobs"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());

GRANT SELECT, INSERT, UPDATE, DELETE ON "automation_jobs" TO jobagent_service;
