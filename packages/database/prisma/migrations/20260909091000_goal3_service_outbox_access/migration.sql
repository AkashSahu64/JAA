-- The outbox publisher runs as the restricted service role and must process
-- tenant-owned events without granting the application role cross-tenant access.
GRANT USAGE ON SCHEMA public, app TO jobagent_service;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO jobagent_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON "outbox_events" TO jobagent_service;
