ALTER TABLE "search_profiles"
  ADD COLUMN "discoveryAccounts" JSONB NOT NULL DEFAULT '[]'::jsonb;
