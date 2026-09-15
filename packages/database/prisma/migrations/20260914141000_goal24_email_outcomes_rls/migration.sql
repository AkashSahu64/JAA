ALTER TABLE "email_outcomes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY email_outcomes_tenant_isolation ON "email_outcomes"
  USING ("userId" = app.current_user_id())
  WITH CHECK ("userId" = app.current_user_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_outcomes" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "email_outcomes" TO jobagent_service;
