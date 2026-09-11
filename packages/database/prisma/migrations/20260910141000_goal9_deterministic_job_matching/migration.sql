-- Make each persisted deterministic match reproducible and inspectable.
ALTER TABLE "job_matches"
  ADD COLUMN "matchingVersion" TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "profileHash" TEXT,
  ADD COLUMN "jobHash" TEXT;

ALTER TABLE "job_matches"
  ADD CONSTRAINT "job_matches_hash_format" CHECK (
    ("profileHash" IS NULL OR "profileHash" ~ '^[a-f0-9]{64}$')
    AND ("jobHash" IS NULL OR "jobHash" ~ '^[a-f0-9]{64}$')
  );

CREATE INDEX "job_matches_matchingVersion_idx" ON "job_matches"("matchingVersion");
