-- Durable outbox claims, terminal failures, and crash-safe lease expiry.
ALTER TABLE "outbox_events"
  ADD COLUMN "failedAt" TIMESTAMP(3),
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

ALTER TABLE "outbox_events"
  ADD CONSTRAINT "outbox_events_lease_consistency"
    CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL)),
  ADD CONSTRAINT "outbox_events_terminal_consistency"
    CHECK (NOT ("publishedAt" IS NOT NULL AND "failedAt" IS NOT NULL));

DROP INDEX "outbox_events_publishedAt_availableAt_idx";
DROP INDEX "outbox_events_unpublished_idx";

CREATE INDEX "outbox_events_publishedAt_failedAt_availableAt_idx"
  ON "outbox_events"("publishedAt", "failedAt", "availableAt");
CREATE INDEX "outbox_events_leaseExpiresAt_idx"
  ON "outbox_events"("leaseExpiresAt");
CREATE INDEX "outbox_events_ready_idx"
  ON "outbox_events"("availableAt", "occurredAt")
  WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;

DROP POLICY "outbox_events_tenant_isolation" ON "outbox_events";
CREATE POLICY "outbox_events_tenant_isolation" ON "outbox_events"
  USING ("userId" = app.current_user_id() OR app.is_service())
  WITH CHECK ("userId" = app.current_user_id() OR app.is_service());
