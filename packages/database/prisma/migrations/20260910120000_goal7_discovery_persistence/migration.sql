-- Durable, tenant-owned discovery execution state and source-item provenance.
CREATE TYPE "DiscoverySource" AS ENUM (
  'GREENHOUSE', 'LEVER', 'ASHBY', 'WORKDAY', 'GENERIC'
);

CREATE TYPE "DiscoveryRunStatus" AS ENUM (
  'PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED'
);

CREATE TYPE "DiscoveryItemStatus" AS ENUM (
  'FETCHED', 'NORMALIZED', 'UPSERTED', 'DUPLICATE', 'REJECTED', 'FAILED'
);

CREATE TYPE "DiscoveryErrorClass" AS ENUM (
  'AUTHENTICATION', 'AUTHORIZATION', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK',
  'SOURCE_UNAVAILABLE', 'NOT_FOUND', 'INVALID_RESPONSE', 'NORMALIZATION',
  'VALIDATION', 'PERSISTENCE', 'CANCELLED', 'INTERNAL'
);

CREATE TABLE "job_discovery_runs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" "DiscoverySource" NOT NULL,
  "sourceAccount" TEXT NOT NULL,
  "searchProfileId" TEXT,
  "requestKey" TEXT NOT NULL,
  "query" JSONB NOT NULL,
  "status" "DiscoveryRunStatus" NOT NULL DEFAULT 'PENDING',
  "cursor" TEXT,
  "nextCursor" TEXT,
  "pageNumber" INTEGER NOT NULL DEFAULT 0,
  "pagesFetched" INTEGER NOT NULL DEFAULT 0,
  "itemsFetched" INTEGER NOT NULL DEFAULT 0,
  "itemsNormalized" INTEGER NOT NULL DEFAULT 0,
  "jobsCreated" INTEGER NOT NULL DEFAULT 0,
  "jobsUpdated" INTEGER NOT NULL DEFAULT 0,
  "itemsDuplicate" INTEGER NOT NULL DEFAULT 0,
  "itemsRejected" INTEGER NOT NULL DEFAULT 0,
  "errorCount" INTEGER NOT NULL DEFAULT 0,
  "errorClass" "DiscoveryErrorClass",
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "errorRetryable" BOOLEAN,
  "errorDetails" JSONB,
  "startedAt" TIMESTAMP(3),
  "heartbeatAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_discovery_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_discovery_items" (
  "id" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "source" "DiscoverySource" NOT NULL,
  "sourceAccount" TEXT NOT NULL,
  "sourceIdentity" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "sourceCursor" TEXT,
  "pageNumber" INTEGER NOT NULL,
  "position" INTEGER NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rawPayload" JSONB NOT NULL,
  "rawContentHash" TEXT NOT NULL,
  "normalizationVersion" INTEGER NOT NULL DEFAULT 1,
  "normalizedPayload" JSONB,
  "fingerprint" TEXT,
  "status" "DiscoveryItemStatus" NOT NULL DEFAULT 'FETCHED',
  "jobId" TEXT,
  "duplicateOfJobId" TEXT,
  "errorClass" "DiscoveryErrorClass",
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "errorRetryable" BOOLEAN,
  "errorDetails" JSONB,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_discovery_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "job_discovery_runs_userId_requestKey_key"
  ON "job_discovery_runs"("userId", "requestKey");
CREATE INDEX "job_discovery_runs_userId_status_createdAt_idx"
  ON "job_discovery_runs"("userId", "status", "createdAt");
CREATE INDEX "job_discovery_runs_source_sourceAccount_createdAt_idx"
  ON "job_discovery_runs"("source", "sourceAccount", "createdAt");
CREATE INDEX "job_discovery_runs_status_heartbeatAt_idx"
  ON "job_discovery_runs"("status", "heartbeatAt");

CREATE UNIQUE INDEX "job_discovery_items_runId_sourceIdentity_key"
  ON "job_discovery_items"("runId", "sourceIdentity");
CREATE INDEX "job_discovery_items_runId_pageNumber_position_idx"
  ON "job_discovery_items"("runId", "pageNumber", "position");
CREATE INDEX "job_discovery_items_source_sourceAccount_sourceIdentity_idx"
  ON "job_discovery_items"("source", "sourceAccount", "sourceIdentity");
CREATE INDEX "job_discovery_items_userId_status_createdAt_idx"
  ON "job_discovery_items"("userId", "status", "createdAt");
CREATE INDEX "job_discovery_items_rawContentHash_idx"
  ON "job_discovery_items"("rawContentHash");
CREATE INDEX "job_discovery_items_fingerprint_idx"
  ON "job_discovery_items"("fingerprint");
CREATE INDEX "job_discovery_items_jobId_idx"
  ON "job_discovery_items"("jobId");
CREATE INDEX "job_discovery_items_duplicateOfJobId_idx"
  ON "job_discovery_items"("duplicateOfJobId");

ALTER TABLE "job_discovery_runs"
  ADD CONSTRAINT "job_discovery_runs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_discovery_runs"
  ADD CONSTRAINT "job_discovery_runs_searchProfileId_fkey"
  FOREIGN KEY ("searchProfileId") REFERENCES "search_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job_discovery_items"
  ADD CONSTRAINT "job_discovery_items_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_discovery_items"
  ADD CONSTRAINT "job_discovery_items_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "job_discovery_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "job_discovery_items"
  ADD CONSTRAINT "job_discovery_items_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "job_discovery_items"
  ADD CONSTRAINT "job_discovery_items_duplicateOfJobId_fkey"
  FOREIGN KEY ("duplicateOfJobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Counter, pagination, timing and terminal-state invariants Prisma cannot express.
ALTER TABLE "job_discovery_runs"
  ADD CONSTRAINT "job_discovery_runs_identity_present" CHECK (
    length(btrim("sourceAccount")) > 0 AND length(btrim("requestKey")) > 0
  ),
  ADD CONSTRAINT "job_discovery_runs_nonnegative_progress" CHECK (
    "pageNumber" >= 0 AND "pagesFetched" >= 0 AND "itemsFetched" >= 0
    AND "itemsNormalized" >= 0 AND "jobsCreated" >= 0 AND "jobsUpdated" >= 0
    AND "itemsDuplicate" >= 0 AND "itemsRejected" >= 0 AND "errorCount" >= 0
  ),
  ADD CONSTRAINT "job_discovery_runs_progress_bounds" CHECK (
    "itemsNormalized" <= "itemsFetched"
    AND "jobsCreated" + "jobsUpdated" + "itemsDuplicate" + "itemsRejected" <= "itemsFetched"
  ),
  ADD CONSTRAINT "job_discovery_runs_time_order" CHECK (
    ("startedAt" IS NULL OR "startedAt" >= "createdAt")
    AND ("heartbeatAt" IS NULL OR ("startedAt" IS NOT NULL AND "heartbeatAt" >= "startedAt"))
    AND ("completedAt" IS NULL OR ("startedAt" IS NOT NULL AND "completedAt" >= "startedAt"))
  ),
  ADD CONSTRAINT "job_discovery_runs_status_consistency" CHECK (
    (("status" IN ('SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')) = ("completedAt" IS NOT NULL))
    AND (("status" IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')) = ("startedAt" IS NOT NULL))
  ),
  ADD CONSTRAINT "job_discovery_runs_error_consistency" CHECK (
    ("errorClass" IS NULL) = ("errorMessage" IS NULL)
    AND ("status" <> 'FAILED' OR "errorClass" IS NOT NULL)
  );

ALTER TABLE "job_discovery_items"
  ADD CONSTRAINT "job_discovery_items_position_nonnegative" CHECK (
    "pageNumber" >= 0 AND "position" >= 0 AND "normalizationVersion" > 0
  ),
  ADD CONSTRAINT "job_discovery_items_identity_present" CHECK (
    length(btrim("sourceAccount")) > 0 AND length(btrim("sourceIdentity")) > 0
  ),
  ADD CONSTRAINT "job_discovery_items_hash_present" CHECK (length("rawContentHash") > 0),
  ADD CONSTRAINT "job_discovery_items_processed_consistency" CHECK (
    (("status" = 'FETCHED') = ("processedAt" IS NULL))
    AND ("processedAt" IS NULL OR "processedAt" >= "fetchedAt")
  ),
  ADD CONSTRAINT "job_discovery_items_job_consistency" CHECK (
    ("jobId" IS NULL OR "status" IN ('UPSERTED', 'DUPLICATE'))
    AND ("duplicateOfJobId" IS NULL OR "status" = 'DUPLICATE')
    AND ("jobId" IS NULL OR "duplicateOfJobId" IS NULL OR "duplicateOfJobId" = "jobId")
  ),
  ADD CONSTRAINT "job_discovery_items_error_consistency" CHECK (
    ("errorClass" IS NULL) = ("errorMessage" IS NULL)
    AND ("status" <> 'FAILED' OR "errorClass" IS NOT NULL)
  );

-- A referenced search profile must belong to the same tenant as its run.
CREATE OR REPLACE FUNCTION app.require_discovery_profile_consistency() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW."userId", NEW.source, NEW."sourceAccount")
         IS DISTINCT FROM (OLD."userId", OLD.source, OLD."sourceAccount")
     AND EXISTS (SELECT 1 FROM job_discovery_items WHERE "runId" = OLD.id) THEN
    RAISE EXCEPTION 'discovery run ownership and source are immutable after items exist' USING ERRCODE = '23514';
  END IF;
  IF NEW."searchProfileId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM search_profiles
    WHERE id = NEW."searchProfileId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'search profile owner does not match discovery run userId' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER job_discovery_runs_profile_consistency
  BEFORE INSERT OR UPDATE OF "userId", "source", "sourceAccount", "searchProfileId" ON "job_discovery_runs"
  FOR EACH ROW EXECUTE FUNCTION app.require_discovery_profile_consistency();

CREATE OR REPLACE FUNCTION app.require_discovery_item_consistency() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM job_discovery_runs
    WHERE id = NEW."runId" AND "userId" = NEW."userId"
      AND source = NEW.source AND "sourceAccount" = NEW."sourceAccount"
  ) THEN
    RAISE EXCEPTION 'discovery item owner or source does not match run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER job_discovery_items_run_consistency
  BEFORE INSERT OR UPDATE OF "userId", "runId", source, "sourceAccount" ON "job_discovery_items"
  FOR EACH ROW EXECUTE FUNCTION app.require_discovery_item_consistency();

CREATE OR REPLACE FUNCTION app.prevent_discovery_run_identity_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM job_discovery_items WHERE "runId" = OLD.id) THEN
    RAISE EXCEPTION 'discovery run identity cannot change after items are persisted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER job_discovery_runs_identity_immutable
  BEFORE UPDATE OF "userId", source, "sourceAccount" ON "job_discovery_runs"
  FOR EACH ROW
  WHEN (OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD.source IS DISTINCT FROM NEW.source OR OLD."sourceAccount" IS DISTINCT FROM NEW."sourceAccount")
  EXECUTE FUNCTION app.prevent_discovery_run_identity_change();

-- Items carry explicit ownership and are also checked against their parent run.
ALTER TABLE "job_discovery_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_discovery_items" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "job_discovery_runs_tenant_isolation" ON "job_discovery_runs"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());
CREATE POLICY "job_discovery_items_tenant_isolation" ON "job_discovery_items"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());

GRANT SELECT, INSERT, UPDATE, DELETE ON "job_discovery_runs", "job_discovery_items" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "job_discovery_runs", "job_discovery_items" TO jobagent_service;
GRANT EXECUTE ON FUNCTION app.require_discovery_profile_consistency() TO jobagent_app, jobagent_service;
GRANT EXECUTE ON FUNCTION app.require_discovery_item_consistency() TO jobagent_app, jobagent_service;
GRANT EXECUTE ON FUNCTION app.prevent_discovery_run_identity_change() TO jobagent_app, jobagent_service;
