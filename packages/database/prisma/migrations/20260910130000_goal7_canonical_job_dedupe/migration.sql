-- Enforce atomic deduplication for Goal 7's existing qualified fingerprint.
-- The discovery service stores a source/account-qualified adapter fingerprint,
-- so uniqueness serializes concurrent writes for that exact key. It does not
-- claim semantic deduplication of mirrored or republished provider listings.
-- PostgreSQL unique indexes allow multiple NULL values, preserving
-- legacy/manual jobs without a fingerprint.
--
-- Abort rather than silently choosing a canonical row if deployed data does
-- not satisfy the new invariant. Remediation must preserve references and is
-- intentionally outside this additive migration.
DO $dedupe_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "jobs"
    WHERE "fingerprint" IS NOT NULL
    GROUP BY "fingerprint"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot enforce jobs_fingerprint_key: duplicate non-null job fingerprints exist';
  END IF;
END
$dedupe_preflight$;

-- Supersede the old fallback-only source/fingerprint constraint and redundant
-- non-unique lookup index. Provider identity uniqueness remains enforced by
-- jobs_source_sourceJobId_key.
DROP INDEX IF EXISTS "jobs_source_fingerprint_key";
DROP INDEX IF EXISTS "jobs_fingerprint_idx";
CREATE UNIQUE INDEX "jobs_fingerprint_key" ON "jobs"("fingerprint");
