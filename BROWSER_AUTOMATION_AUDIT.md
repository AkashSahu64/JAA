# Browser Automation Audit

## Verdict

**Browser automation completion: 0/100.** No Playwright/Puppeteer dependency, browser worker, browser session, form detector, field mapper, answer resolver, file uploader, submission action, or confirmation verifier exists. The UI accurately acknowledges this in `apps/web/src/views/AutomationView.tsx` and `apps/web/src/views/ApplicationsView.tsx`.

The system cannot open, fill, submit, or verify an employer application. External application links opened by the Jobs view are ordinary user navigation and do not constitute automation.

## Capability Matrix

| Capability | UI | API/service | Worker | Durable state | Tests | Status |
|---|---|---|---|---|---|---|
| Open employer application | External link only | No | No | No | No | 🔴 Missing |
| Browser/session creation | No | No | No | No BrowserSessionReference | No | 🔴 Missing |
| Allowed-host navigation | No | No | No | No | No | 🔴 Missing |
| Redirect/private-network checks | No | URL helper only | No | No | No | 🔴 Missing |
| Page/form detection | No | No | No | No | No | 🔴 Missing |
| Multi-step form handling | No | No | No | No | No | 🔴 Missing |
| Field extraction | No | No | No | JSON question field only | No | 🔴 Missing |
| Field mapping | No | No | No | No normalized mappings | No | 🔴 Missing |
| Profile answer lookup | No | Partial agent method | No | Profile fields exist | No | 🟠 Disconnected |
| Custom-question answer | Placeholder | Partial AI class | No | No normalized answer/version | No | 🟠 Disconnected |
| Sensitive/high-risk approval | Placeholder copy | No | No | No HumanVerification | No | 🔴 Missing |
| Resume/cover-letter upload | No | Master resume upload only | No | ApplicationDocument model | No | 🔴 Missing |
| CAPTCHA handoff | Placeholder | No | No | Status string only | No | 🔴 Missing |
| MFA handoff | Fake notification example | No | No | Status string only | No | 🔴 Missing |
| Save/resume browser session | No | No | No | No session reference | No | 🔴 Missing |
| Submit action | No | No | No | Submission fields only | No | 🔴 Missing |
| Confirmation-page detection | No | No | No | Confirmation fields only | No | 🔴 Missing |
| Receipt/screenshot capture | No | No | No | Path fields only | No object storage | 🔴 Missing |
| Email confirmation | No | No | No | No email model | No | 🔴 Missing |
| Retry/replay | No | Counters only | No | Attempt fields exist | No | 🔴 Missing |
| Browser audit trail | No | No writes | No | AuditLog unused | No | 🔴 Missing |

## Actual Application Path

```text
Jobs UI → open external application URL in the user's browser
```

There is no internal path equivalent to:

```text
AutomationJob → browser lease → allowlisted navigation → form snapshot
→ field mapping → policy/approval gate → fill → upload → submit
→ confirmation evidence → transactional result → UI event
```

## Existing Scaffolding That Does Not Count as Execution

- `ApplicationAttempt` has fields suitable for timestamps, errors, field counts, logs, and screenshot paths, but no browser code creates attempts.
- `ApplicationDocument` can represent associated files, but no form uploader consumes it.
- `Application.questions` is JSON, but no browser extractor normalizes or populates it.
- `WAITING_FOR_USER` exists as a string, but no durable request, notification, handoff token, expiry, or continuation protocol exists.
- The QuestionAgent can classify some question patterns, but it receives no live form and cannot write approved answers back to a browser.
- Header MFA and submission notifications are hardcoded fake examples, not browser-worker events.

## Required Security Boundary

A production browser worker must treat every employer page, job description, DOM string, script, download, and redirect as untrusted data. Page content must never become tool policy or override system rules.

Mandatory controls:

1. Source-specific adapters and explicit HTTPS hostname allowlists.
2. DNS resolution and redirect revalidation with loopback, link-local, private-network, metadata-service, and non-HTTP(S) denial.
3. Isolated browser context per attempt; no shared cookies, storage, credentials, or downloads across users.
4. Credentials supplied through short-lived references, never embedded in queue payloads, logs, screenshots, or prompts.
5. Strict download/upload paths, MIME and magic-byte checks, malware scanning, size limits, and checksums.
6. DOM extraction schemas and output encoding; never execute page-authored instructions as agent commands.
7. Capability-scoped tools: navigate, inspect, fill approved field, upload approved artifact, and request approval.
8. Submission disabled by default until all deterministic gates and user policy checks pass.
9. CAPTCHA and MFA must pause for the user; the system must not bypass or outsource them.
10. Redacted screenshots/logs, bounded retention, tenant isolation, and append-only audit records.

## Required State Model

A real workflow must distinguish at least:

`QUEUED → NAVIGATING → FORM_DETECTED → MAPPING → WAITING_FOR_USER/CAPTCHA_REQUIRED/MFA_REQUIRED → READY_TO_SUBMIT → SUBMISSION_PENDING → SUBMITTED_UNCONFIRMED → CONFIRMED`

Failure branches require `RETRY_PENDING`, `FAILED`, `SKIPPED`, and `CANCELLED`, each with a normalized failure class, attempt number, retry policy, actor, reason, evidence, and timestamps. A click alone must never set `CONFIRMED`.

## Human Verification Contract

Human handoff requires a durable `HumanVerification` record linked to the application, attempt, and browser-session reference. It must contain the reason, safe prompt, requested fields, expiry, status, response provenance, and resume command. The UI needs authenticated view/respond/cancel actions and a notification backed by real data. Continuation must be idempotent and revalidate the session/page before acting.

## Submission Verification Standard

A submission is confirmed only when one or more allowlisted evidence strategies succeed:

- confirmation page with stable employer/provider identifiers;
- structured success response tied to the attempt;
- employer application ID;
- confirmation email matched to user, company, role, and attempt;
- stored redacted screenshot/receipt with checksum.

Evidence, parser version, source URL, timestamps, and object checksum must be persisted before status changes to `CONFIRMED`. Ambiguous success belongs in `SUBMITTED_UNCONFIRMED` for review.

## Acceptance Tests

Before real submission is enabled, tests must prove:

- known Greenhouse and Lever fixtures, including multi-step and conditional forms;
- required/optional fields, radio/checkbox/select/date/file controls, validation messages, and dynamic DOM updates;
- redirects and hostile URL/page-content rejection;
- CAPTCHA/MFA pause without bypass and safe resume;
- crash recovery after each state boundary;
- duplicate-delivery idempotency and no duplicate submission;
- cancellation and emergency-stop propagation;
- retryable versus permanent failure handling and DLQ behavior;
- redaction and cross-tenant isolation of cookies, files, screenshots, and logs;
- confirmation and false-positive rejection.

## Conclusion

Browser/application automation is entirely absent. The next browser-related work should begin only after durable PostgreSQL commands/outbox/idempotency, BullMQ execution, application state transitions, private object storage, and human-verification records are operational and tested. Building a direct Playwright script before those controls would create an unsafe, non-recoverable submission path.
