CREATE TABLE "refresh_token_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "familyId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_token_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refresh_token_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "refresh_token_sessions_tokenHash_key" ON "refresh_token_sessions"("tokenHash");
CREATE INDEX "refresh_token_sessions_userId_revokedAt_idx" ON "refresh_token_sessions"("userId", "revokedAt");
ALTER TABLE "refresh_token_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY refresh_token_sessions_tenant_isolation ON "refresh_token_sessions" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "refresh_token_sessions" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "refresh_token_sessions" TO jobagent_service;
