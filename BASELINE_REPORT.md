# Baseline Report

> Goal 0 execution record — 2026-09-09

## Repository and Toolchain

- Platform: Windows 11; PowerShell primary.
- Repository root: `C:\Users\Home\.gemini\antigravity\scratch\job-application-agent`.
- Source control: no `.git` repository is present. This is a rollback and change-audit risk.
- Package manager: npm 11.19.0 with npm workspaces (`apps/*`, `packages/*`).
- Runtime: Node.js 24.20.0.
- ORM: Prisma CLI/Client 5.22.0.
- Workspaces typechecked: API, web, AI, job engine, resume engine, security, and shared types.

## Verification Results

| Verification | Result |
|---|---|
| `npm run typecheck` | PASS — 7 workspaces |
| `npm run lint` | PASS |
| `npm test` | PASS — 4 files, 24/24 tests |
| `npm run build` | PASS — API TypeScript and web Vite production build |
| `npx prisma migrate status` | CONNECTED — live PostgreSQL reached; no migration history exists yet, so Goal 1 must establish the baseline |
| Docker Desktop | PASS — 4.90.0; Docker Engine 29.7.2 and Compose 5.5.1 operational |
| WSL2 | PASS — WSL 2.7.13.0, kernel 6.18.33.2-2; `docker-desktop` running on WSL2 |
| PostgreSQL | PASS — PostgreSQL 16.15 container healthy; `pg_isready` and authenticated SQL query passed |
| Rollback | PASS — explicit Goal 0 source snapshot created outside the project root with SHA-256 evidence; Git history remains absent |

The live dependency check now proves Docker/WSL2 operation and PostgreSQL 16.15 connectivity. It does not prove database-backed API flows yet: no Prisma migrations exist, so the database is intentionally empty and unmanaged until Goal 1 establishes a reviewed baseline migration. Redis, workers, object storage, and E2E operation remain outside Goal 0 and unverified.

## Dependency and Environment Baseline

Current code has PostgreSQL/Prisma, Express, React/Vite, AI HTTP integration, PDF/DOCX parsing, Greenhouse/Lever discovery, and utility tests. The dependency lock does not contain BullMQ, Redis client, Playwright, AWS S3 client, OpenTelemetry, Prometheus metrics, or pgvector application support. `.env.example` and Compose currently define no complete Redis, object-storage, browser-worker, email/OAuth, or telemetry environment.

The user selected Docker enablement for mandatory local integration/E2E infrastructure. Docker Desktop, WSL2, and PostgreSQL are now operational. Goal 0 is complete based on the recorded static suite, live dependency checks, and the explicit rollback snapshot; durable schema and database-backed integration work begins in Goal 1.

## Truthfulness Fixes Applied

The following misleading UI behavior was removed as part of stabilization:

1. Header hardcoded MFA/submission/interview notifications were replaced by authenticated `/notifications` API data.
2. Header mark-all-read now calls `POST /notifications/mark-all-read`; it no longer only closes the menu.
3. The command label “Tailor & Create New Resume” was renamed to “Open Resume Studio,” matching its navigation-only behavior.
4. “View Application Queue” was renamed to “View Application Records,” because no queue exists yet.
5. Generic AI loading text no longer claims it is analyzing job telemetry.

These changes do not create automation; they make the current product accurately describe what it does.

## Goal 0 Completion Evidence

- WSL 2.7.13.0 with kernel 6.18.33.2-2 is operational; the Docker Desktop WSL2 distribution is running.
- Docker Desktop 4.90.0, Docker Engine 29.7.2, and Docker Compose 5.5.1 respond successfully.
- `postgres:16-alpine` is healthy; PostgreSQL reports version 16.15, `pg_isready` accepts connections, and an authenticated SQL query succeeds.
- Prisma reaches `jobagent` at `localhost:5432`; its only reported issue is the expected absence of migrations, assigned to Goal 1.
- `npm run check` passes: Prisma generation, seven workspace typechecks, lint, 4 test files/24 tests, and both production builds.
- `npm audit --audit-level=high` reports zero vulnerabilities.
- Rollback snapshot: `job-application-agent-goal0-20260909-022227.zip`, stored outside the repository root, 15,769,561 bytes, SHA-256 `7B04F071A626788F0A0E02A9A173D14FE12241D49BE13EE424241BE34EE2B86C`.
- The directory still has no Git history. The explicit snapshot satisfies the immediate rollback requirement, but Git initialization remains recommended before collaborative or release work.

Goal 1 subsequently established the PostgreSQL/Prisma foundation: the pinned `pgvector/pgvector:0.8.1-pg16` runtime, reviewed initial migration, required extensions, typed lifecycle enums, durable execution/evidence models, database constraints and indexes, ownership consistency triggers, restricted-role RLS, deterministic synthetic seed, migration verification scripts, live integration tests, and a successful backup/restore drill. The standard suite remains 24/24; the database suite passes 7/7 separately because it requires the live Compose dependency.
