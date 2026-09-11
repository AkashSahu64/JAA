-- Permit durable rejection records when malformed provider data has no source
-- identity. Every status that can continue through discovery processing still
-- requires a real, nonblank provider identity.
ALTER TABLE "job_discovery_items"
  ALTER COLUMN "sourceIdentity" DROP NOT NULL,
  DROP CONSTRAINT "job_discovery_items_identity_present",
  ADD CONSTRAINT "job_discovery_items_identity_present" CHECK (
    length(btrim("sourceAccount")) > 0
    AND (
      "status" = 'REJECTED'
      OR (
        "sourceIdentity" IS NOT NULL
        AND length(btrim("sourceIdentity")) > 0
      )
    )
  );
