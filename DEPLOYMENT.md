# Deployment Contract

The production Compose file runs three application processes: the dashboard web
server, the authenticated API, and the durable worker. PostgreSQL, Redis,
private object storage, malware scanning, OAuth providers, and telemetry are
external dependencies and must be supplied by the deployment environment.

1. Copy `.env.production.example` to a secret-managed `.env.production` and
   replace every placeholder. Do not commit the populated file.
2. Apply Prisma migrations from a controlled migration job using
   `DATABASE_ADMIN_URL`; application containers use the non-owner
   `DATABASE_URL`.
3. Build and start with the same environment file so the dashboard’s
   `VITE_API_BASE_URL` is available at build time:

   ```text
   docker compose --env-file .env.production -f compose.production.yaml build
   docker compose --env-file .env.production -f compose.production.yaml up -d
   ```

4. Confirm `/api/health` for liveness and `/api/ready` for PostgreSQL-backed
   readiness before routing traffic to the web service. The production API
   container healthcheck uses `/api/ready`; the web container healthcheck only
   confirms static dashboard delivery, so orchestration must gate API traffic on
   both checks as appropriate for the deployment.
5. Keep real provider submission disabled until external-provider, secret-store,
   rollback, restore, telemetry, and human-verification operations have been
   separately approved and evidenced.

The disposable restore rehearsal (`npm run test:backup:restore`) reports elapsed
restore time and accepts an optional `RESTORE_DRILL_MAX_SECONDS` bound for a
measured local recovery objective. This is rehearsal evidence only; production
RPO/RTO targets still require deployment-specific backup frequency, restore
capacity, and an approved operational runbook.

The image is pinned to a Node base digest, installs Chromium at build time, and
runs API/worker/web processes as the `jobagent` user with read-only filesystems,
dropped capabilities, bounded process counts, and no-new-privileges.
