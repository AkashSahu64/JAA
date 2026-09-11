-- Persist immutable application quality decisions and concurrency-safe daily reservations.
CREATE TABLE "application_quality_decisions" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "decision" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "inputHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "application_quality_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "application_quality_decisions_decision_check" CHECK ("decision" IN ('PASS', 'FAIL', 'SKIPPED')),
  CONSTRAINT "application_quality_decisions_hash_format" CHECK ("inputHash" ~ '^[a-f0-9]{64}$')
);

CREATE TABLE "daily_application_budget_reservations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "day" DATE NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_application_budget_reservations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "application_quality_decisions_applicationId_inputHash_key"
  ON "application_quality_decisions"("applicationId", "inputHash");
CREATE INDEX "application_quality_decisions_userId_createdAt_idx"
  ON "application_quality_decisions"("userId", "createdAt");
CREATE UNIQUE INDEX "daily_application_budget_reservations_applicationId_key"
  ON "daily_application_budget_reservations"("applicationId");
CREATE UNIQUE INDEX "daily_application_budget_reservations_userId_day_applicationId_key"
  ON "daily_application_budget_reservations"("userId", "day", "applicationId");
CREATE INDEX "daily_application_budget_reservations_userId_day_idx"
  ON "daily_application_budget_reservations"("userId", "day");

ALTER TABLE "application_quality_decisions"
  ADD CONSTRAINT "application_quality_decisions_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "application_quality_decisions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "daily_application_budget_reservations"
  ADD CONSTRAINT "daily_application_budget_reservations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "daily_application_budget_reservations_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "application_quality_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "daily_application_budget_reservations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "application_quality_decisions_tenant_isolation" ON "application_quality_decisions"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());
CREATE POLICY "daily_application_budget_reservations_tenant_isolation" ON "daily_application_budget_reservations"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());

GRANT SELECT, INSERT, UPDATE, DELETE ON "application_quality_decisions", "daily_application_budget_reservations" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "application_quality_decisions", "daily_application_budget_reservations" TO jobagent_service;
