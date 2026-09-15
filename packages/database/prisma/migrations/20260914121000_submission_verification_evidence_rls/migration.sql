ALTER TABLE "submission_verification_evidence" ENABLE ROW LEVEL SECURITY;

CREATE POLICY submission_verification_evidence_tenant_isolation
  ON "submission_verification_evidence"
  USING ("userId" = app.current_user_id())
  WITH CHECK ("userId" = app.current_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON "submission_verification_evidence" TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "submission_verification_evidence" TO jobagent_service;
