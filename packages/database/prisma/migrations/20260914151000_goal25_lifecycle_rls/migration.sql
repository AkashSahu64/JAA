ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY interviews_tenant_isolation ON "interviews" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY offers_tenant_isolation ON "offers" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "interviews" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "interviews" TO jobagent_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON "offers" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "offers" TO jobagent_service;
