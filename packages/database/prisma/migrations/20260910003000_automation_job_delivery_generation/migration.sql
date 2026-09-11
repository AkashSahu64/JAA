ALTER TABLE "automation_jobs"
  ADD COLUMN "deliveryGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "automation_jobs"
  ADD CONSTRAINT "automation_jobs_delivery_generation_positive"
  CHECK ("deliveryGeneration" > 0);
