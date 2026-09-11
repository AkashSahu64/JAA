# Production Readiness

## Readiness Decision

**Production readiness: 25/100 — NOT READY.** The repository builds and its limited utility tests pass, but the core product workflow is absent. It should be operated only as a development/assisted dashboard. Real autonomous submission must remain disabled.

| Domain | Score | Current evidence | Release blocker |
|---|---:|---|---|
| Product completeness | 28 | CRUD, upload/parsing, manual discovery, read dashboards | No end-to-end application workflow |
| Database | 59 | PostgreSQL/Prisma schema with 20 models | No migrations, constraints, outbox, idempotency, RLS |
| API/backend | 44 | Authenticated CRUD/read routes | Missing orchestration, application creation, transition service |
| Frontend | 48 | Major assisted views exist | Key controls absent; fake notifications |
| AI/agents | 28 | Provider and specialized prompt classes | No production invocation, schemas, provenance, evaluation |
| Queue/workers | 0 | None | Redis/BullMQ and all worker semantics absent |
| Browser/submission | 0 | None | Entire execution and verification subsystem absent |
| Security/privacy | 48 | bcrypt, JWT checks, Helmet/CORS/rate limits | Refresh revocation, RLS, secrets, file/PII controls absent |
| Observability | 18 | Logging and heartbeat SSE | No traces, metrics, alerts, distributed event transport |
| Testing | 18 | 22 utility tests; lint/typecheck/build pass | No API/DB/AI/worker/browser/E2E coverage |
| Infrastructure | 25 | Local PostgreSQL Compose declaration | No Redis, storage, workers, deployment/backup topology |
| Operations/recovery | 10 | Some attempt/run fields | No leases, DLQ, replay, restore test, graceful drain |

## Verified Build Health

The audit observed:

```text
ESLint: passed
TypeScript: passed in 7 workspaces
Vitest: 3 source test files; 22 passed, 0 failed, 0 skipped
API build: tsc passed
Web build: tsc && vite build passed; 1503 modules transformed
```

This proves source consistency and selected utility behavior only. It does not validate a live database or any product workflow. PostgreSQL verification failed with `P1001: Can't reach database server at localhost:5432`; Docker and `psql` were unavailable, so database behavior remains statically assessed.

## Release Gates

| Gate | Required evidence | Current result |
|---|---|---|
| Reproducible environment | Versioned migrations, seed/fixtures, health checks | ❌ Missing; seed target is absent |
| Live DB correctness | Migration, constraints, concurrency, backup/restore tests | ❌ Not tested |
| Authentication lifecycle | Rotation, reuse detection, logout/revocation, client refresh | ❌ Incomplete |
| Tenant isolation | Ownership tests plus PostgreSQL RLS | ❌ No RLS/cross-tenant suite |
| Durable execution | PostgreSQL command/outbox + BullMQ workers | ❌ Missing |
| Idempotency | Duplicate delivery and crash recovery tests | ❌ Missing |
| AI safety/quality | Runtime schemas, provenance, hostile-input evaluations | ❌ Missing |
| Resume truthfulness | Source facts and deterministic claim verifier | ❌ Missing |
| Browser safety | URL/tool/file/credential isolation tests | ❌ Browser absent |
| Submission correctness | Confirmed evidence, no duplicate submission | ❌ Missing |
| Human approval | Durable CAPTCHA/MFA/sensitive-answer workflow | ❌ Missing |
| Observability | Metrics, traces, alerts, correlation IDs, runbooks | ❌ Incomplete |
| Data protection | Object storage, encryption policy, retention/deletion | ❌ Incomplete |
| Production operations | Deployment, secrets, scaling, rollback, DR rehearsal | ❌ Missing |

## Critical Correctness Risks

1. **False automation state:** Start creates `AutomationRun(status=RUNNING)` without launching work.
2. **Invalid lifecycle:** the PATCH route permits any allowlisted status jump with last-write-wins behavior.
3. **False operational signals:** Header MFA, submission, and interview notifications are hardcoded; “Mark all read” only closes the menu.
4. **AI output trust:** `completeJSON<T>` parses syntax but does not enforce schema, ranges, enums, totals, citations, or truthfulness.
5. **Unverified analytics:** metrics summarize stored rows, not independently verified submissions.
6. **Provider failure masking:** discovery adapters can convert external errors to empty result sets.
7. **Session expiry:** refresh tokens are returned but the web client does not store/use them; tokens are stateless and non-revocable.
8. **File/PII storage:** resume bytes are stored in PostgreSQL without object-storage policy, malware scanning, retention, or deletion workflow.
9. **Process-local security state:** credential vault data is in a Map and unsuitable for durable production credentials.
10. **No crash boundary:** there is no durable lease, command, outbox, replay, or worker drain protocol.

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

`.env.example` declares database, AI, encryption, JWT, API, frontend, and a local storage path. It lacks Redis/BullMQ, S3, browser-worker, email/OAuth, telemetry, and production-secret references. `compose.yaml` declares only PostgreSQL. There is no production deployment, worker topology, reverse proxy, Redis, object store, monitoring, or backup service in the repository.

## Deployment Recommendation

Do not deploy this as an autonomous agent or enable real submission. A limited internal development deployment may expose authenticated CRUD, manual Greenhouse/Lever import, resume parsing, stored-record dashboards, and generic AI chat only if the UI continues to label these honestly and fake notifications are removed.

Reassess readiness after P0 and P1 gates are implemented and demonstrated through live integration, concurrency, crash-recovery, security, and browser E2E tests. Static classes and passing compilation must not be accepted as release evidence.
