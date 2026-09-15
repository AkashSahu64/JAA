ALTER TABLE "email_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_connections_tenant_isolation ON "email_connections" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_connections" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_connections" TO jobagent_service;
