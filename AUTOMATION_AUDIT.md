# Automation Audit

## Verdict

**AUTONOMOUS JOB APPLICATION SCORE: 10/100.** Subsystem arithmetic average is 15/100, but the pipeline score is capped by the absence of a durable queue, browser worker, real submission, and verification. The repository implements run-state records, not autonomous execution.

| Automation area | Score | What works | Decisive missing capability |
|---|---:|---|---|
| Job Discovery | 45/100 | Manual Greenhouse/Lever API import | Scheduler, profiles, durable runs, limits, workers |
| Job Analysis | 10/100 | Uncalled LLM class | Production invocation, validation, persistence/versioning |
| Matching | 10/100 | Uncalled weighted LLM class | Deterministic scoring, persistence flow, qualification |
| Resume | 15/100 | Upload/parser plus uncalled tailoring class | Structured profile, durable generation, file output |
| ATS | 10/100 | Uncalled LLM scanner | Deterministic signals, gate, persistence, tests |
| Application | 5/100 | Rows can be listed/status-patched | Creation, queue, quality gate, execution |
| Browser | 0/100 | Nothing | Entire subsystem |
| Human-in-loop | 5/100 | WAITING_FOR_USER string/placeholder copy | Durable request, notification, resume session |
| Tracking | 15/100 | Manual rows and outcome models | Confirmation/email ingestion and lifecycle automation |
| Analytics | 35/100 | Real DB counts/timeline | Verified-source data and deeper dimensions |

## Intended vs Actual Control Flow

```text
Intended:
SearchProfile/schedule → durable command → BullMQ worker → discover → analyze → match
→ tailor → ATS gate → AutomationJob → browser worker → verify → transaction/update/outbox → SSE/UI

Actual:
User clicks Discover → API calls Greenhouse/Lever synchronously → serial Prisma upserts → UI reloads
User clicks Start → API creates AutomationRun(status=RUNNING) → no work starts
```

## Application Queue Audit

| Requirement | Status | Evidence / consequence |
|---|---|---|
| PostgreSQL durable work record | 🔴 | AutomationRun groups no AutomationJob units. |
| Redis connection | 🔴 | No dependency/configuration/client. |
| BullMQ queue | 🔴 | No producer, queue, worker, or scheduler. |
| Scheduling | 🔴 | SearchProfile schedule/customCron are never consumed. |
| Retry/backoff | 🔴 | Application retry counters exist, no retry executor. |
| Concurrency | 🔴 | No worker concurrency or source/user budgets. |
| Priority | 🔴 | No queue job priority. |
| Cancellation | 🔴 | Stop mutates a row; no in-flight job receives cancellation. |
| Pause/resume | ⚠️ | Run row changes only; worker consumption is unaffected because workers do not exist. |
| Dead-letter handling | 🔴 | No DLQ/failure queue. |
| Idempotency | 🟡 | Unique application/user/job and active run key help, but no command/attempt idempotency. |
| Duplicate protection | 🟡 | Some DB uniqueness, no at-least-once execution safety. |
| Queue metrics | 🔴 | Counters are stored but no worker updates them. |
| Graceful shutdown | 🔴 | No queue/worker drain; no Prisma disconnect path. |

## Automation Controls

| Control | UI | API | Durable record | Worker effect | Verdict |
|---|---|---|---|---|---|
| Start | Yes | Creates run | Yes | None | 🟡 Record only |
| Pause | Yes | Updates status | Yes | None | 🟡 Record only |
| Resume | Yes | Updates status | Yes | None | 🟡 Record only |
| Stop | API exists; no frontend call | Updates/clears key | Yes | None | 🟠 Backend only |
| Emergency stop | API exists; no frontend call | Updates/clears key | Yes | None | 🟠 Backend only |

`apps/web/src/views/AutomationView.tsx:39` explicitly states that the backend does not launch Playwright, fill forms, or submit applications. This statement matches the execution-path audit.

## Rules and Limits

The database and API can persist thresholds, schedules, daily application caps, sources, company filters, geography, roles, and a JSON rule array. `RulesEngine` can evaluate basic operators in memory. No scheduler, discovery orchestration, matching service, or application worker loads these records. Therefore every automation limit and preference has **zero enforcement effect** today.

Required enforcement order:

1. Load tenant/user/search profile and active rules from durable state.
2. Validate daily/hourly/company/source budgets transactionally.
3. Run deterministic eligibility and match/ATS gates.
4. Reserve an idempotent AutomationJob/application attempt.
5. Execute via source-specific worker with rate limiting.
6. Finalize counters/outcome/audit/outbox in one transaction.

## State Machine Audit

Current route allowlist includes `DISCOVERED, QUALIFIED, RESUME_GENERATED, APPLICATION_STARTED, FORM_FILLED, WAITING_FOR_USER, SUBMITTED, CONFIRMED, INTERVIEW, OFFER, REJECTED, FAILED, WITHDRAWN`. Missing target states include `ATS_VALIDATED, QUEUED, CAPTCHA_REQUIRED, MFA_REQUIRED, SUBMISSION_PENDING, SUBMITTED_UNCONFIRMED, RETRY_PENDING, ACCEPTED, SKIPPED`.

| Control | Current | Required |
|---|---|---|
| Typed status | String + route Set | Shared enum + DB enum/check |
| Transition graph | None | Explicit allowlisted graph |
| Concurrency | Last write wins | Row version or lock |
| Transaction | Update then reread | State + transition + audit + outbox atomically |
| History | Milestone timestamps only | Immutable ApplicationStatusTransition |
| Actor/reason | Notes partially | Actor, command, reason, metadata |
| Audit event | None | Append-only AuditLog |
| Worker command | None | Idempotent outbox/AutomationJob |

## Live Activity

Authenticated SSE and frontend streaming parsing are real. The server emits connection/heartbeat frames and keeps clients in a process-local map. `broadcastToUser` has no production caller. No worker events exist, no distributed pub/sub bridges replicas, and AutomationEvent rows are not relayed live. Current “live” behavior proves connectivity, not operational activity.

## Four Pipeline Failure Points

- **Resume-driven flow:** fails first at resume-to-structured-profile conversion.
- **Discovery-driven flow:** fails first at automatic analysis/matching invocation.
- **Execution flow:** fails immediately because no durable queue/worker exists.
- **Outcome flow:** fails at external confirmation ingestion; email tracking is absent.

## Failure and Recovery Audit

ApplicationAttempt can store attempt number, errors, timestamps, field counts, screenshot path, and logs. No code creates browser attempts. There is no normalized failure class, retry policy, lease expiry, poison-job policy, resumable browser session, screenshot/object persistence, or operator replay. A process crash would have no durable claimed-work protocol to recover.

## Minimum Acceptance Criteria for Real Automation

1. Durable `AutomationJob`, `OutboxEvent`, `IdempotencyRecord`, `ApplicationStatusTransition`, `FailureRecord`, and `HumanVerification` records.
2. BullMQ producer/consumer with bounded concurrency, source/user rate limits, exponential backoff, DLQ, cancellation, metrics, and graceful drain.
3. Every handler safely repeatable under at-least-once delivery.
4. Validated analysis/match/tailor/ATS outputs persisted with model/prompt/input versions.
5. Application creation and quality gate transactionally reserve one user/job application.
6. Allowlisted browser adapters with restricted navigation and no CAPTCHA/MFA bypass.
7. Submission states distinguish click, pending, unconfirmed, confirmed, and failure.
8. Confirmation evidence and object checksums persist before `CONFIRMED`.
9. Controls operate real worker queues and leases, not only run records.
10. Integration, crash-recovery, concurrency, and E2E tests prove the flow.

## Conclusion

The repository is an assisted dashboard and backend foundation. It is **not** a semi-automated or autonomous application engine. Calling the current Application list a queue or an AutomationRun row an active automation process would be technically inaccurate.
