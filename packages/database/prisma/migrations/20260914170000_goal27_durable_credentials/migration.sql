CREATE TABLE "credential_records" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "encryptedValue" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "credential_records_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "credential_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "credential_records_userId_name_key" ON "credential_records"("userId", "name");
CREATE INDEX "credential_records_userId_revokedAt_idx" ON "credential_records"("userId", "revokedAt");
