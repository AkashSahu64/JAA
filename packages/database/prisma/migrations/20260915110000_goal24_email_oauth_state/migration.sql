CREATE TABLE "email_oauth_states" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "stateHash" TEXT NOT NULL,
  "encryptedCodeVerifier" TEXT NOT NULL,
  "redirectUri" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_oauth_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "email_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "email_oauth_states_stateHash_key" ON "email_oauth_states"("stateHash");
CREATE INDEX "email_oauth_states_userId_expiresAt_idx" ON "email_oauth_states"("userId", "expiresAt");
CREATE INDEX "email_oauth_states_userId_consumedAt_idx" ON "email_oauth_states"("userId", "consumedAt");
