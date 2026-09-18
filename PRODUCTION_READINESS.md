# Production Readiness

## Readiness Decision

**Production readiness: NOT READY.** The repository now contains durable application state, provider adapters, form intelligence, private-storage boundaries, independent verification, scheduling, notifications, analytics, and recovery controls. Disposable PostgreSQL/Redis/S3 paths, encrypted backup readability, and local Chromium provider execution now have verified evidence, but production deployment/telemetry, live external-provider behavior, broader failure drills, and the final autonomous E2E certification remain incomplete. Real external submission must remain disabled.

| Domain | Score | Current evidence | Release blocker |
|---|---:|---|---|
| Product completeness | partial | Durable discovery → matching → resume/application preparation and supervised provider paths exist | Full live workflow and final E2E certification are missing |
| Database | partial | Prisma schema, versioned migrations, tenant predicates/RLS migrations, outbox, idempotency, and durable leases exist; schema validation and migration parity report all 45 migrations applied in disposable PostgreSQL, the aggregate runner passes 36 files/139 tests, and a fresh dump restores into a unique disposable database with 44 public tables verified | Production deployment, production restore, and broader live SQL evidence remain gated |
| API/backend | partial | Authenticated orchestration, lifecycle transitions, submission attempts, verification, scheduling, outcomes, and analytics exist | Live infrastructure execution remains gated |
| Frontend | partial | Dashboard reflects jobs, applications, schedules, notifications, outcomes, and analytics from API data; production Compose serves the built SPA through a hardened static web container with configurable API base; Chromium smoke verifies authenticated stats and Application Queue rendering | Full live-state UX, reverse-proxy/managed-domain wiring, and backend-connected dashboard E2E remain open |
| AI/agents | 28 | Provider and specialized prompt classes | No production invocation, schemas, provenance, evaluation |
| Queue/workers | partial | Redis/BullMQ workers, leases, retries, DLQ, renewal/error callbacks, and durable dispatch exist | Writable Redis and outage/restart drills are gated |
| Browser/submission | partial | Greenhouse/Lever adapters, provider-neutral form intelligence, exact documents, human handoff, independent verification, and a real local Chromium provider-service → verifier fixture exist | External-provider behavior and production browser operations remain gated |
| Security/privacy | partial | Auth, refresh sessions, tenant checks/RLS migrations, credential isolation, document validation, encryption, and prompt-injection boundaries exist | Full deployment audit and cross-tenant live evidence remain |
| Observability | partial | Correlation IDs, structured bounded/redacted logs, request/worker events, SSE, and durable notifications exist | Metrics/traces/log shipping/alerts are not validated |
| Testing | partial | Controlled unit/browser suites plus the current workspace run (92 files/932 tests, 41 files/172 tests explicitly skipped), live disposable PostgreSQL (36 files/139 tests), Redis outage recovery (1/1), S3 (3/3), live local Chromium certification, encrypted backup integrity, and a disposable destructive restore rehearsal are recorded; gated files remain explicitly excluded from pass counts | Hosted CI execution, external provider behavior, production restore, and broader failure drills remain incomplete |
| Infrastructure | partial | Development Compose declares PostgreSQL, Redis, MinIO, health checks, and private-bucket initialization; production Compose now defines separate non-root API/worker/web containers with read-only filesystems, dropped capabilities, readiness healthchecks, and the hosted CI contract includes a disposable dashboard route/security smoke gate | Image build, production topology, scaling, and managed service operations remain unverified |
| Operations/recovery | partial | Leases, retries, dead-lettering, reconciliation, graceful drain, backup/restore scripts, disposable PostgreSQL restart plus Redis outage recovery drills, and a timed disposable restore rehearsal exist; the latest 325,566-byte restore completed in 44.028s and the optional bound fails closed when exceeded | Production RPO/RTO targets, production crash/restart drills, and managed recovery operations remain unverified |

## Verified Build Health

## Current Environment Revalidation (2026-09-16)

The latest controlled infrastructure run used the repository's disposable Docker services before Docker Desktop became unavailable. PostgreSQL, Redis, and MinIO/S3 were reachable for the recorded integration runners. The latest full `npm test` completed with 92 test files and 932 tests passed, with 41 files and 172 tests explicitly skipped by declared infrastructure/browser gates. No external provider or mailbox was contacted.

The latest controlled audit observed:

```text
ESLint: passed
TypeScript: passed in all configured workspaces
Vitest workspace suite: 92 files and 932 tests passed; 41 files and 172 tests explicitly skipped. Disposable PostgreSQL runner: 36 files and 139 tests passed. Redis outage recovery: 1 test passed. S3 integration: 3 tests passed. Live local Chromium certification: 4 tests passed. Non-destructive encrypted backup drill passed with 316,164 bytes dumped, encrypted, checksummed, decrypted, and restore-read; the latest disposable destructive restore rehearsal verified 44 public tables in 44.028s, while a configured 120-second bound correctly rejected a slower 181.097s run.
API build: tsc passed
Web build: tsc && vite build passed; 1503 modules transformed
Production runtime image: a prior image was verified with non-root UID 999, Chromium runtime path, offline dependency audit, API liveness/fail-closed readiness, and disposable PostgreSQL/Redis-backed API plus worker smoke behavior; the latest optimized rebuild was not completed because Docker Desktop's Linux engine is unavailable
```

These results prove source consistency and selected disposable infrastructure behavior, including local provider-service execution and the disposable production image; they do not validate external provider behavior or the complete product workflow. PostgreSQL, Redis, and MinIO were exercised through the approved Docker path; production deployment, provider variability, destructive restore, production key management, and final E2E evidence remain gated.

## Release Gates

| Gate | Required evidence | Current result |
|---|---|---|
| Reproducible environment | Versioned migrations, seed/fixtures, health checks | ⚠️ Compose, migrations, fixtures, and health checks exist; disposable startup is verified, production startup remains gated |
| Live DB correctness | Migration, constraints, concurrency, backup/restore tests | ⚠️ Migration parity, disposable concurrency/isolation evidence, and a disposable destructive restore rehearsal are verified; production restore remains gated |
| Authentication lifecycle | Rotation, reuse detection, logout/revocation, client refresh | ⚠️ Durable refresh sessions and revocation exist; live deployment evidence is gated |
| Tenant isolation | Ownership tests plus PostgreSQL RLS | ⚠️ Ownership/RLS migrations exist; live cross-tenant SQL tests are gated |
| Durable execution | PostgreSQL command/outbox + BullMQ workers | ⚠️ Implemented and unit-tested; live services are gated |
| Idempotency | Duplicate delivery and crash recovery tests | ⚠️ Focused replay/recovery coverage exists; live crash drills are gated |
| AI safety/quality | Runtime schemas, provenance, hostile-input evaluations | ⚠️ Truthfulness/policy gates exist; production model evaluation is incomplete |
| Resume truthfulness | Source facts and deterministic claim verifier | ⚠️ Implemented with focused coverage; live workflow evidence is gated |
| Browser safety | URL/tool/file/credential isolation tests | ⚠️ Provider-host and human-handoff controls plus local fixtures exist; live providers are gated |
| Submission correctness | Confirmed evidence, no duplicate submission | ⚠️ Exact-document/idempotent attempt/independent-verification paths exist; local Chromium/PostgreSQL evidence is verified, external evidence is gated |
| Human approval | Durable CAPTCHA/MFA/sensitive-answer workflow | ⚠️ Human-verification and approved-answer paths exist; live handoff is gated |
| Observability | Metrics, traces, alerts, correlation IDs, runbooks | ⚠️ Structured logs/correlation exist; metrics/traces/alerts are incomplete |
| Data protection | Object storage, encryption policy, retention/deletion | ⚠️ Private S3-compatible boundary and validation exist; disposable S3 upload/auth/tamper evidence is verified, production storage remains gated |
| Production operations | Deployment, secrets, scaling, rollback, DR rehearsal | ⚠️ Configuration/backup scripts and a disposable DR rehearsal exist; deployment, rollback, and managed DR operations remain incomplete |

## Critical Correctness Risks

1. **External execution evidence:** local provider/browser execution, independent confirmation, and database state transitions are verified; external provider behavior and production browser operations have not been exercised.
2. **Infrastructure scope:** disposable PostgreSQL, Redis, and MinIO/S3 paths now have targeted evidence, but this is not production topology or operational proof.
3. **Integration coverage:** explicitly gated files remain outside the passing counts; their results must not be inferred from unit or fixture tests.
4. **Telemetry operations:** structured logs and correlation fields exist, but shipping, metrics, traces, alert thresholds, and runbooks are not validated.
5. **Disaster recovery:** the Docker backup path creates, encrypts, checksums, decrypts, and restore-validates a custom-format dump, and the disposable restore rehearsal recreates it in a unique temporary database before cleanup while reporting elapsed restore time; production key-management/rotation, production restore, and deployment-specific RPO/RTO evidence remain outstanding.
6. **Provider variability:** Greenhouse and Lever live pages, policy changes, authentication, CAPTCHA/MFA handoff, and rate-limit behavior remain unverified.
7. **Final workflow certification:** local submission/verification/dashboard slices pass, but no full USER PROFILE → DISCOVERY → APPLICATION → DOCUMENT → SUBMISSION → VERIFICATION → DASHBOARD E2E certification has passed.

## Production Topology Decision

The approved architecture remains:

```text
React UI → Express API → PostgreSQL 16 + Prisma + JSONB + FTS/trigram + pgvector
                           ↓ transactional outbox
                        Redis/BullMQ
                           ↓
                  discovery / AI / browser workers
                           ↓
                  durable results in PostgreSQL

Private S3-compatible storage: resumes, generated documents, screenshots, receipts, large logs
OpenSearch: optional derived projection only after measured need
```

PostgreSQL remains the system of record. MongoDB is not recommended or required. Redis is transient coordination, not the authoritative store. Object metadata and checksums belong in PostgreSQL; private object bytes belong in S3-compatible storage.

## Security Minimums Before Beta

- Short-lived access tokens and rotating, hashed, revocable refresh sessions with reuse detection.
- Email verification, secure recovery, logout-all-sessions, and audited security events.
- Tenant-aware data model, ownership checks, RLS, and cross-tenant integration tests.
- Managed secret references; no provider/browser credentials in database plaintext, queue payloads, prompts, or logs.
- MIME plus magic-byte checks, malware scanning, private buckets, signed short-lived downloads, checksums, and retention/deletion jobs.
- AI input minimization, runtime output schemas, prompt/version hashes, hostile-input tests, and claim verification.
- Browser host allowlists, redirect/SSRF controls, isolated contexts, capability-scoped actions, and mandatory user handoff for CAPTCHA/MFA.
- Immutable audit and transition records with actor, command, reason, correlation, and evidence.

## Observability and Operations Minimums

Every API command and worker attempt needs a correlation ID and structured events. Required metrics include queue depth/age, job latency, retries/DLQ, provider failures, model tokens/cost, browser state durations, submission confirmation rates, and human-verification age. Add distributed tracing, SLOs, alerts, dashboards, and runbooks for provider outage, queue backlog, stuck lease, duplicate command, object failure, and emergency stop.

Backups require automated encrypted PostgreSQL backups, object versioning/retention as appropriate, restore drills, and documented RPO/RTO. The disposable restore rehearsal now satisfies the local restore-test gate; production restore, key-management, and measured RPO/RTO evidence remain required.

## Environment Status

`.env.example` declares database, AI, encryption, JWT, API, Redis/BullMQ, private S3-compatible storage, scanner, scheduler, worker, and `BACKUP_ENCRYPTION_KEY` settings. `.env.production.example`, `Dockerfile`, and `compose.production.yaml` now define the production API/worker/web container contract, and the hosted CI workflow contains dashboard route/security plus local certification gates; deployment, secret-store wiring, external telemetry sink, and production OAuth/provider execution remain unverified. The disposable encrypted backup and restore rehearsals are complete; production restore and key-management evidence remain gated.

## Deployment Recommendation

Do not deploy this as an autonomous agent or enable unrestricted real submission. A limited internal development deployment may expose the authenticated discovery, preparation, supervised Greenhouse/Lever, document, verification, scheduling, outcome, and analytics paths while all live-provider and infrastructure gates remain visible and human verification remains mandatory.

Reassess readiness after P0 and P1 gates are implemented and demonstrated through live integration, concurrency, crash-recovery, security, and browser E2E tests. Static classes and passing compilation must not be accepted as release evidence.
