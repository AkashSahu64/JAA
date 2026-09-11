-- Preserve reproducibility and operational provenance for validated job analyses.
ALTER TABLE "job_analyses"
  ADD COLUMN "analysisVersion" TEXT,
  ADD COLUMN "schemaVersion" TEXT,
  ADD COLUMN "promptVersion" TEXT,
  ADD COLUMN "providerName" TEXT,
  ADD COLUMN "providerVersion" TEXT,
  ADD COLUMN "modelName" TEXT,
  ADD COLUMN "modelVersion" TEXT,
  ADD COLUMN "inputHash" TEXT,
  ADD COLUMN "outputHash" TEXT,
  ADD COLUMN "latencyMs" INTEGER,
  ADD COLUMN "inputTokens" INTEGER,
  ADD COLUMN "outputTokens" INTEGER,
  ADD COLUMN "totalTokens" INTEGER,
  ADD COLUMN "costAmount" DOUBLE PRECISION,
  ADD COLUMN "costCurrency" TEXT,
  ADD COLUMN "costEstimated" BOOLEAN,
  ADD COLUMN "confidence" JSONB,
  ADD COLUMN "trustBoundary" JSONB;

ALTER TABLE "job_analyses"
  ADD CONSTRAINT "job_analyses_latency_nonnegative"
    CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0),
  ADD CONSTRAINT "job_analyses_tokens_nonnegative"
    CHECK (
      ("inputTokens" IS NULL OR "inputTokens" >= 0)
      AND ("outputTokens" IS NULL OR "outputTokens" >= 0)
      AND ("totalTokens" IS NULL OR "totalTokens" >= 0)
      AND (
        "totalTokens" IS NULL
        OR ("inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND "totalTokens" = "inputTokens" + "outputTokens")
      )
    ),
  ADD CONSTRAINT "job_analyses_cost_nonnegative"
    CHECK ("costAmount" IS NULL OR "costAmount" >= 0),
  ADD CONSTRAINT "job_analyses_hash_format"
    CHECK (
      ("inputHash" IS NULL OR "inputHash" ~ '^[a-f0-9]{64}$')
      AND ("outputHash" IS NULL OR "outputHash" ~ '^[a-f0-9]{64}$')
    );

CREATE INDEX "job_analyses_inputHash_idx" ON "job_analyses"("inputHash");
