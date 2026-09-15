ALTER TABLE "interviews" ADD COLUMN "sourceEventId" TEXT;
ALTER TABLE "offers" ADD COLUMN "sourceEventId" TEXT;
CREATE UNIQUE INDEX "interviews_userId_sourceEventId_key" ON "interviews"("userId", "sourceEventId");
CREATE UNIQUE INDEX "offers_userId_sourceEventId_key" ON "offers"("userId", "sourceEventId");
