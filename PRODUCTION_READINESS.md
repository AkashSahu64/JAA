# Production Readiness

## Readiness Decision

**Production readiness: NOT READY.** The repository now contains durable application state, provider adapters, form intelligence, private-storage boundaries, independent verification, scheduling, notifications, analytics, and recovery controls. Disposable PostgreSQL/Redis/S3 paths, encrypted backup readability, and local Chromium provider execution now have verified evidence, but production deployment/telemetry, live external-provider behavior, broader failure drills, and the final autonomous E2E certification remain incomplete. Real external submission must remain disabled.

| Domain | Score | Current evidence | Release blocker |
|---|---:|---|---|
| Product completeness | partial | Durable discovery → matching → resume/application preparation and supervised provider paths exist | Full live workflow and final E2E certification are missing |
| Database | partial | Prisma schema, versioned migrations, tenant predicates/RLS migrations, outbox, idempotency, and durable leases exist; all 41 migrations are applied in disposable PostgreSQL and the aggregate runner passes 28 files/115 tests | Production deployment, destructive restore, and broader live SQL evidence remain gated |
| API/backend | partial | Authenticated orchestration, lifecycle transitions, submission attempts, verification, scheduling, outcomes, and analytics exist | Live infrastructure execution remains gated |
| Frontend | partial | Dashboard reflects jobs, applications, schedules, notifications, outcomes, and analytics from API data | Full live-state UX and E2E dashboard evidence are missing |
| AI/agents | 28 | Provider and specialized prompt classes | No production invocation, schemas, provenance, evaluation |
| Queue/workers | partial | Redis/BullMQ workers, leases, retries, DLQ, renewal/error callbacks, and durable dispatch exist | Writable Redis and outage/restart drills are gated |
| Browser/submission | partial | Greenhouse/Lever adapters, provider-neutral form intelligence, exact documents, human handoff, independent verification, and a real local Chromium provider-service → verifier fixture exist | External-provider behavior and production browser operations remain gated |
| Security/privacy | partial | Auth, refresh sessions, tenant checks/RLS migrations, credential isolation, document validation, encryption, and prompt-injection boundaries exist | Full deployment audit and cross-tenant live evidence remain |
| Observability | partial | Correlation IDs, structured bounded/redacted logs, request/worker events, SSE, and durable notifications exist | Metrics/traces/log shipping/alerts are not validated |
| Testing | partial | Controlled unit/browser suites plus live disposable PostgreSQL (28 files/115 tests), Redis outage recovery (1/1), S3 (3/3), live local Chromium certification, and non-destructive encrypted backup evidence are recorded; gated files remain explicitly excluded from pass counts | Full discovery-to-dashboard E2E, external provider behavior, destructive restore, and broader failure drills remain incomplete |
| Infrastructure | partial | Compose declares PostgreSQL, Redis, MinIO, health checks, and private-bucket initialization; disposable services were exercised through the approved Docker path | Production topology, scaling, and managed service operations remain unverified |
| Operations/recovery | partial | Leases, retries, dead-lettering, reconciliation, graceful drain, backup/restore scripts, and a non-destructive encrypted Docker backup drill exist | Destructive restore, measured RPO/RTO, and production crash/restart drills are not executed |

## Verified Build Health

## Current Environment Revalidation (2026-09-15)

The disposable-service results below are historical evidence from an earlier controlled environment and were not reproduced in the current session. Docker Desktop start/status was attempted through the approved local command, but the Linux engine API named pipe remained absent; `docker info` therefore still failed. The latest full `npm test` rerun completed with 82 test files and 747 tests passed, with 36 files and 132 tests explicitly skipped. Focused tests and static checks are also passing, while PostgreSQL, Redis, MinIO/S3 runtime, and full autonomous E2E claims remain environment-gated.

The latest controlled audit observed:

```text
ESLint: passed
TypeScript: passed in all configured workspaces
Vitest controlled serial suite: 76 files and 629 tests passed; 35 files and 125 tests explicitly skipped. Disposable PostgreSQL runner: 28 files and 115 tests passed. Redis outage recovery: 1 test passed. S3 integration: 3 tests passed. Live local Chromium certification: 4 tests passed. Non-destructive encrypted backup drill passed.
API build: tsc passed
Web build: tsc && vite build passed; 1503 modules transformed
```

These results prove source consistency and selected disposable infrastructure behavior, including local provider-service execution, but do not validate external provider behavior or the complete product workflow. PostgreSQL, Redis, and MinIO were exercised through the approved Docker path; production deployment, provider variability, destructive restore, and final E2E evidence remain gated.

## Release Gates

| Gate | Required evidence | Current result |
|---|---|---|
| Reproducible environment | Versioned migrations, seed/fixtures, health checks | ⚠️ Compose, migrations, fixtures, and health checks exist; disposable startup is verified, production startup remains gated |
| Live DB correctness | Migration, constraints, concurrency, backup/restore tests | ⚠️ Static schema/migrations exist; live migration and restore tests are gated |
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
| Production operations | Deployment, secrets, scaling, rollback, DR rehearsal | ⚠️ Configuration/backup scripts exist; deployment and DR rehearsal are incomplete |

## Critical Correctness Risks

1. **External execution evidence:** local provider/browser execution, independent confirmation, and database state transitions are verified; external provider behavior and production browser operations have not been exercised.
2. **Infrastructure scope:** disposable PostgreSQL, Redis, and MinIO/S3 paths now have targeted evidence, but this is not production topology or operational proof.
3. **Integration coverage:** explicitly gated files remain outside the passing counts; their results must not be inferred from unit or fixture tests.
4. **Telemetry operations:** structured logs and correlation fields exist, but shipping, metrics, traces, alert thresholds, and runbooks are not validated.
5. **Disaster recovery:** a non-destructive Docker backup drill creates, encrypts, checksums, decrypts, and restore-validates a custom-format dump; destructive restore rehearsal, production key-management/rotation, and measured RPO/RTO evidence remain outstanding.
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

Backups require automated encrypted PostgreSQL backups, object versioning/retention as appropriate, restore drills, and documented RPO/RTO. A backup that has not been restored in a test does not satisfy the gate.

## Environment Status

`.env.example` declares database, AI, encryption, JWT, API, Redis/BullMQ, private S3-compatible storage, scanner, scheduler, and worker settings. `compose.yaml` declares PostgreSQL, Redis, MinIO, health checks, and private-bucket initialization. There is still no validated production deployment topology, external telemetry sink, OAuth mailbox provider, or completed backup/restore drill.

## Deployment Recommendation

Do not deploy this as an autonomous agent or enable unrestricted real submission. A limited internal development deployment may expose the authenticated discovery, preparation, supervised Greenhouse/Lever, document, verification, scheduling, outcome, and analytics paths while all live-provider and infrastructure gates remain visible and human verification remains mandatory.

Reassess readiness after P0 and P1 gates are implemented and demonstrated through live integration, concurrency, crash-recovery, security, and browser E2E tests. Static classes and passing compilation must not be accepted as release evidence.
