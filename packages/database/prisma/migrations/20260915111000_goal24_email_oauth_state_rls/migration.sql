ALTER TABLE "email_oauth_states" ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_oauth_states_tenant_isolation ON "email_oauth_states" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_oauth_states" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_oauth_states" TO jobagent_service;
