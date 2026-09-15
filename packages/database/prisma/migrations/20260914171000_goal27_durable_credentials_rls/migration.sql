ALTER TABLE "credential_records" ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_records_tenant_isolation ON "credential_records" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "credential_records" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "credential_records" TO jobagent_service;
