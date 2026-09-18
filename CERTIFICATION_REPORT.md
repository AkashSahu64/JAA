# Autonomous Job Application Agent Certification Report

Date: 2026-09-16  
Decision: **NOT CERTIFIED FOR AUTONOMOUS PRODUCTION SUBMISSION**

This report records the strongest evidence currently available. It is intentionally not a production-readiness or external-provider success claim.

## Verified local evidence

| Boundary | Result | Evidence |
|---|---|---|
| Resume parsing → discovery → analysis → matching → tailoring → ATS → quality → application preparation | PASS | `ResumeParser` extracts a real resume buffer before approved facts are persisted; the live disposable PostgreSQL handler fixture then executes `ANALYZE_JOB` → `MATCH_JOB` → `TAILOR_RESUME` → `EVALUATE_ATS` → application intent → quality → exact tailored-document form preparation before browser submission |
| Provider-neutral form intelligence | VERIFIED | Shared FormDetector/FieldExtractor/FieldMapper/AnswerResolver; deterministic policy classes; approved-answer/provenance checks |
| Greenhouse/Lever local provider paths | PASS | Local Chromium fixtures, exact approved document transport, validation, dynamic/multi-step handling, human-verification handoff, and the real queued Greenhouse handler/service path through `FORM_FILLED` |
| Private document storage | VERIFIED LOCALLY | Disposable MinIO upload/read, checksum/tamper checks, authorization, encryption metadata, retention/deletion, and immutable ResumeVersion binding |
| Submission → independent confirmation → durable state | PASS LOCALLY | Explicit approval → durable authorization → authorized local Chromium submit-control interaction using the exact tailored document → `UNCONFIRMED` → queued confirmation verifier → verifier-only `CONFIRMED` transition, durable evidence, and idempotent replay; reviewed profile-reference answers are covered by policy regression tests |
| Notification/dashboard readback | PASS LOCALLY | Durable outbox consumption plus authenticated jobs/match, applications, analytics, and notifications readback after confirmation; rejection and withdrawal lifecycle transitions now have explicit notification mappings; the disposable web image serves the dashboard shell, client-side routes, and hashed assets, and the Chromium dashboard smoke renders fixture stats and Application Queue state through the real SPA |
| Human verification | PASS LOCALLY | CAPTCHA fixture creates `HumanVerification`, pauses safely, and resumes only after explicit acknowledgement; CAPTCHA is never solved or bypassed |
| Recovery/infrastructure checks | PASS LOCALLY | PostgreSQL restart, Redis outage drill, MinIO/S3 suite, encrypted backup drill, migration verification, database-isolation gate, and disposable API/worker container smoke tests |

## Current aggregate evidence

- Workspace unit suite: 92 files passed, 932 tests passed; 41 files and 172 tests explicitly skipped by declared gates.
- PostgreSQL integration: 36 files, 139/139 tests passed.
- BullMQ/Redis integration: 3 files, 16/16 tests passed.
- Redis outage recovery: 1/1 passed.
- MinIO/S3 integration: 3/3 passed.
- Encrypted backup drill: 316,164 bytes dumped, encrypted, checksummed, decrypted, and restore-readable.
- Prisma schema valid; 45 migrations applied.
- Root lint and API/web/queue production builds passed; web build transformed 1,503 modules.
- Coverage audit: 132 test files, 43 gated files, 9 runner scripts, 0 unreachable gated files.
- Production runtime image: a prior pinned-image build was verified with non-root UID 999, Chromium at `/ms-playwright`, offline audit clean, API readiness/liveness smoke against disposable PostgreSQL/Redis, and worker smoke against fresh disposable Redis. The latest optimized rebuild and current container execution are gated because Docker Desktop's Linux engine is unavailable.
- Dashboard runtime smoke: disposable web container served `/`, `/applications`, and the hashed JavaScript asset with HTTP 200 responses.
- Dashboard browser smoke: Chromium-enabled disposable runtime rendered authenticated fixture statistics and the persisted application state after real sidebar navigation; API responses were deterministic in-process fixtures and no external service was contacted.
- Hosted certification gate: CI now provisions disposable pgvector PostgreSQL, applies migrations with the production runtime image, and runs the local autonomous Chromium/PostgreSQL fixture before teardown; no hosted run has been observed yet.

## Deliberate certification limits

The following are not claimed:

- No real Greenhouse, Lever, Gmail, or Microsoft Graph account was contacted.
- No external job application was submitted.
- Production S3/KMS/malware-scanner, telemetry backend, deployment, rollback, destructive restore, RPO/RTO, and managed OAuth evidence are not certified.
- The local deterministic one-run fixture now covers user profile/resume facts → discovery → analysis → matching → truthful tailoring → ATS → quality → application → exact document → browser form fill → explicit authorization → submission → independent verification → jobs/applications/analytics/notification readback. Resume parsing and CAPTCHA handoff are additionally covered by separate fixtures; neither local fixture is evidence of a real external provider submission or production deployment.

Until those gates have acceptable evidence, the system must remain restricted to local deterministic fixtures and explicit human approval. Unrestricted real-world submission remains disabled.
