-- Scope durable deduplication keys by tenant to prevent cross-tenant collisions.
DROP INDEX "automation_jobs_idempotencyKey_key";
CREATE UNIQUE INDEX "automation_jobs_userId_idempotencyKey_key"
  ON "automation_jobs"("userId", "idempotencyKey");

DROP INDEX "idempotency_records_scope_key_key";
CREATE UNIQUE INDEX "idempotency_records_userId_scope_key_key"
  ON "idempotency_records"("userId", scope, key) NULLS NOT DISTINCT;

DROP INDEX "application_status_transitions_idempotencyKey_key";
CREATE UNIQUE INDEX "application_status_transitions_userId_idempotencyKey_key"
  ON "application_status_transitions"("userId", "idempotencyKey");
