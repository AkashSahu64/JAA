# Next Implementation Plan

## Objective and Guardrails

Transform the current assisted dashboard into a durable, policy-controlled job-application system. Implement in dependency order; do not begin real browser submission until data integrity, queue semantics, application policy, human approval, and evidence storage are operational.

Locked architecture: PostgreSQL/Prisma is the system of record; PostgreSQL JSONB handles flexible provider/AI data; pgvector supports semantic retrieval; Redis/BullMQ handles transient queueing and coordination; private S3-compatible storage holds files/evidence; OpenSearch is optional and derived. Do not introduce MongoDB.

## Priority Summary

| Priority | Outcome | Exit condition |
|---|---|---|
| P0 | Honest, durable execution foundation | Live DB migrations, typed state machine, outbox/idempotency, queue/workers, integrated AI pipeline, no false UI state |
| P1 | Safe application execution | Structured profile/resume, application quality gate, storage, human handoff, restricted browser adapters, confirmation evidence |
| P2 | Product completion and operations | Scheduling, notifications/realtime, email outcomes, analytics, observability, security hardening, recovery |
| P3 | Scale and optimization | pgvector relevance, source expansion, optional OpenSearch, cost/performance optimization, learning/evaluation loop |

## P0 — Correctness and Durable Orchestration

### P0.1 Reproducible PostgreSQL baseline

- Start a safe local PostgreSQL environment and verify connection health.
- Create reviewed, additive Prisma/SQL migrations; stop relying on schema push.
- Add a valid idempotent development seed or remove the broken seed declaration.
- Replace lifecycle strings with shared enums/check constraints.
- Add row versioning/timestamps and indexes for active jobs, applications, queue claims, status, user, and source identity.
- Add migration-forward, rollback/restore, and schema-drift CI tests.

**Exit:** clean database can migrate and seed; existing data has a reviewed backfill path; constraints are verified against live PostgreSQL.

### P0.2 Transactional application state model

Add `ApplicationStatusTransition`, `AuditLog` writes, normalized `FailureRecord`, and explicit transition commands. Enforce a transition graph in one service and transaction. Record actor, reason, command/idempotency key, old/new state, metadata, and correlation ID. Use optimistic locking or row locks. Remove direct route-level arbitrary status mutation.

**Exit:** invalid jumps and stale writes fail; state, history, audit, and outbox commit atomically; concurrency tests pass.

### P0.3 Outbox, idempotency, and durable work records

Add `AutomationJob`, `OutboxEvent`, and `IdempotencyRecord` with payload schema/version, aggregate reference, status, priority, available time, attempts, lease owner/expiry, cancellation, and failure data. Build an outbox publisher with safe claim/retry semantics. Every command and handler must be repeatable under at-least-once delivery.

**Exit:** duplicate commands/deliveries and crashes at each commit boundary do not duplicate applications or lose work.

### P0.4 Redis/BullMQ control plane

Pin BullMQ/Redis client versions. Add queues for discovery, AI pipeline, document generation, browser application, events, and DLQ. Implement bounded concurrency, exponential backoff with jitter, per-user/source limits, cancellation, pause/resume, graceful drain, stalled-job handling, metrics, and replay tooling. PostgreSQL remains authoritative.

**Exit:** Start/pause/resume/stop controls affect real queued/leased work; emergency stop prevents new irreversible steps; crash recovery tests pass.

### P0.5 Production-integrate analysis, match, resume, and ATS

Invoke the pipeline from durable workers after job persistence. Add runtime schemas and deterministic cross-field checks for every model output. Persist provider/model, prompt/schema versions, input/output hashes, tokens, cost, latency, and failure class. Recompute weighted match totals deterministically. Split ATS into measurable deterministic signals; use the LLM only for bounded suggestions.

**Exit:** a persisted job and profile produce versioned analysis, match, resume proposal, and ATS result through queued execution; invalid model output cannot advance the state.

### P0.6 Correct misleading interfaces

Replace Header constants with the notifications API and real producers; make mark-read call the backend. Rename/remove “Tailor & Create New Resume” until it performs that action. Replace “Analyzing job telemetry” with accurate generic-chat copy. Make every run/queue/status label reflect actual durable state.

**Exit:** no UI control or label claims an external action that did not occur.

## P1 — Safe Application Capability

### P1.1 Structured profile and resume provenance

Normalize experience, education, skills, projects, certifications, languages, work authorization, locations, and preferences from resumes into reviewable candidate facts. Add stable `ResumeSourceFact` identifiers and citations. Require user approval for extracted facts. Tailoring may select/rephrase approved facts but cannot create facts; reject unsupported claims deterministically.

### P1.2 Document generation and private object storage

Add private S3-compatible storage and object metadata/checksums in PostgreSQL. Implement malware/magic-byte validation, signed short-lived access, retention/deletion, and encryption policy. Generate tested PDF and DOCX artifacts, preserve accessible text extraction, and associate exact document versions with application attempts.

### P1.3 Application creation and quality gate

Create one idempotent application per user/job after eligibility, rule, limit, match, resume, ATS, truthfulness, and document checks. Evaluate authorization, location, salary, blocked companies, application budgets, required skills, and user automation mode deterministically. Persist every decision and reason.

### P1.4 Human verification workflow

Add durable `HumanVerification` and normalized question/answer/version records. Implement authenticated review/respond/cancel APIs, real notifications, expiry/escalation, and idempotent resume commands. CAPTCHA and MFA always pause for user action and are never bypassed. Sensitive or ambiguous answers require explicit approval.

### P1.5 Restricted browser adapters

Build isolated Playwright workers behind source-specific adapters, starting with fixture-backed Greenhouse and Lever. Enforce HTTPS hostname/redirect/private-network rules, context isolation, credential references, download/upload restrictions, redacted evidence, and capability-scoped operations. Detect/map/fill before submission is enabled.

### P1.6 Submission and independent verification

Model `READY_TO_SUBMIT`, `SUBMISSION_PENDING`, `SUBMITTED_UNCONFIRMED`, and `CONFIRMED` separately. Require policy and approval gates immediately before the irreversible action. Persist provider response, employer ID, confirmation page/email evidence, screenshot/receipt checksum, and parser version. Never infer confirmation from a click or URL change alone.

**P1 exit:** one allowlisted provider can execute fixture, sandbox, then explicitly approved live flows without duplicate submission; CAPTCHA/MFA handoff, crash recovery, cancellation, evidence, and false-positive rejection pass E2E tests.

## P2 — Product and Operational Completion

1. Consume SearchProfile schedules/cron through durable scheduler commands; enforce source/user/company budgets transactionally.
2. Expand rules UI to strict typed conditions with preview/explanation and production evaluation.
3. Replace process-local SSE delivery with outbox-backed distributed event propagation and API-backed notifications.
4. Add provider/OAuth email ingestion for confirmation, interview, rejection, and offer linking with user consent and minimal scopes.
5. Build interview/offer workflows, review room, retry/replay controls, source/role/company/resume funnel analytics, and evidence drill-down.
6. Implement rotating hashed refresh sessions, reuse detection, revocation/logout, verification/recovery, secure credential references, RLS, and cross-tenant tests.
7. Add structured logs, traces, SLOs, alerts, queue/browser/AI metrics, cost controls, runbooks, encrypted backups, and restore/DR rehearsals.
8. Add API/DB/AI/worker/browser/security/load tests and CI release gates.

## P3 — Scale, Relevance, and Learning

1. Add pgvector embeddings for job/profile/resume retrieval only after deterministic eligibility; version embeddings and models.
2. Measure PostgreSQL FTS/trigram relevance and query performance before considering an OpenSearch derived index.
3. Add Workday/Ashby/generic discovery through compliant, rate-limited adapters with durable source runs and provenance.
4. Optimize batching, cache safe derived data, partition high-volume event/attempt tables when measurements justify it, and enforce cost budgets.
5. Create offline evaluation sets for extraction, matching stability, ATS signals, unsupported claims, hostile inputs, question policy, and confirmation accuracy.
6. Add outcome attribution and policy recommendations with human review; do not silently retrain or alter submission policy from noisy outcomes.

## Test Sequence

| Layer | Required proof |
|---|---|
| Unit | Transition graph, rule/limit engine, schemas, ATS signals, claim verifier, URL policy |
| Database | Migrations, constraints, transactions, locks, RLS, outbox claims, idempotency |
| API integration | Auth lifecycle, ownership, uploads, CRUD, commands, approvals, notifications |
| Worker | Retries, backoff, leases, cancellation, pause/resume, DLQ, graceful drain |
| AI evaluation | Invalid JSON/shape/ranges, injection, stability, citations, unsupported claims |
| Browser fixtures | Form variants, dynamic steps, uploads, validation, hostile pages, handoff |
| E2E | Discover → analyze → match → resume → ATS → apply → verify → UI |
| Resilience | Worker/API/Redis/provider/object-store failures and recovery without duplication |
| Operations | Load, backup/restore, deployment rollback, alert and emergency-stop drills |

## Next Five Execution Steps

1. Bring up PostgreSQL safely and implement additive migrations for state transitions, outbox, idempotency, failures, and AutomationJob.
2. Add Redis/BullMQ producers and workers with real pause/resume/stop, limits, retries, DLQ, and crash-safe idempotency.
3. Connect discovery to validated, versioned analysis → match → tailoring → deterministic ATS → application reservation.
4. Add structured source facts, PDF/DOCX generation, private object storage, and durable human verification.
5. Implement allowlisted Greenhouse/Lever browser adapters and evidence-based submission verification, then prove the full flow with E2E tests before enabling live submission.

## Completion Definition

The project is complete only when a real, policy-eligible job can move through `JOB → JD ANALYSIS → MATCH → RESUME → ATS → FORM → SUBMIT → VERIFY`, with durable state at every boundary, no invented candidate facts, no CAPTCHA/MFA bypass, safe retries without duplicate submission, confirmation evidence, full auditability, and UI updates backed by actual execution. Until then, it remains an assisted development system.
