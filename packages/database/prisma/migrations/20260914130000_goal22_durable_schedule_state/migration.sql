ALTER TABLE "search_profiles"
  ADD COLUMN "timeZone" TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN "nextRunAt" TIMESTAMP(3),
  ADD COLUMN "lastRunAt" TIMESTAMP(3);

CREATE INDEX "search_profiles_isActive_nextRunAt_idx"
  ON "search_profiles"("isActive", "nextRunAt");
