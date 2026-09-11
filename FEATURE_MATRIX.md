# Feature Matrix

Status legend: 🟢 fully implemented · 🟡 partially implemented · 🔵 UI only · 🟠 backend only · 🔴 not implemented · ⚠️ broken · 🧪 implemented but untested.

## Core Product Matrix

| Feature | Frontend | Backend | DB | Worker | AI | Integration | Tests | Status | % | Evidence / problem / next action |
|---|---|---|---|---|---|---|---|---|---:|---|
| Registration/login/session | Yes | Yes | User | — | — | Partial | Utility only | 🟡 | 65 | Auth routes/UI real; refresh returned but frontend ignores it; add rotation/revocation and API tests. |
| User profile | No routed editor | CRUD | UserProfile | — | — | Not consumed | No | 🟠 | 40 | API persists fields; discovery/matching/rules do not consume them. |
| Search profiles | No | CRUD | SearchProfile | No scheduler | — | Not consumed | No | 🟠 | 35 | Schedule/limits persist but affect nothing. |
| Resume upload | Yes | Real parser route | Resume | — | — | UI→API→DB static | No | 🧪 | 65 | PDF/DOCX/TXT extraction; DB unavailable; add integration/malware tests and object storage. |
| Structured profile extraction | No | No | JSON fields only | — | No | No | No | 🔴 | 5 | Sections only; normalize experience/skills/education/projects/certifications. |
| Resume tailoring | Viewer only | Agent class | ResumeVersion model | No | Yes | Disconnected | No | 🟠 | 28 | Supervisor-only call; validate provenance, persist, expose API. |
| Resume PDF/DOCX output | No | No | filePath field | No | — | No | No | 🔴 | 0 | Generator emits HTML/text only. |
| ATS scoring | Displays stored score | Agent class | Scalar/JSON | No | Yes | Disconnected | No | 🟠 | 22 | LLM score is unvalidated/non-deterministic; implement measurable scanner. |
| Greenhouse discovery | Yes | Adapter/API | Job upsert | No | — | Manual | No | 🧪 | 65 | Real public API; errors collapse to empty list; add fixtures, limits, provenance. |
| Lever discovery | Yes | Adapter/API | Job upsert | No | — | Manual | No | 🧪 | 65 | Real public API; company is slug; add tests and failure reporting. |
| Workday/Ashby/generic discovery | No | No | No | No | — | No | No | 🔴 | 0 | Adapters absent. |
| Durable deduplication | No control | In-memory engine | Partial unique | No | — | Partial | No | 🟡 | 45 | URL/fingerprint similarity not enforced durably. |
| Job analysis | Read display | Agent class | JobAnalysis | No | Yes | No caller | No | 🟠 | 25 | Add versioned schema validation and queued invocation. |
| Job matching | Score display/filter | Agent class | JobMatch | No | Yes | No caller | No | 🟠 | 25 | No deterministic recomputation, embeddings, freshness, or enforcement. |
| Rules | Limited CRUD | CRUD + engine | UserRule | No | — | Engine uncalled | No | 🟡 | 35 | UI cannot author conditions; add schema/editor/evaluation service. |
| Application creation | No | No POST create | Application | No | — | No | No | 🔴 | 5 | Model exists; no service creates a qualified application. |
| Application list/detail | Yes | Yes | Application/Attempt | — | — | Read path | No | 🧪 | 55 | Real authenticated reads; no live DB verification. |
| Application state changes | No UI mutation | PATCH | String status | No | — | Unsafe | No | ⚠️ | 25 | Any allowlisted state can jump to any other; add transition service/history/outbox. |
| Durable queue | Queue label | No | No AutomationJob | No | — | No | No | 🔴 | 0 | Add BullMQ backed by durable PostgreSQL commands. |
| Automation controls | Yes | Run-row CRUD | AutomationRun | No | — | Records only | No | 🟡 | 20 | Start/pause/resume/stop do not control execution. |
| Browser automation | No | No | No session model | No | — | No | No | 🔴 | 0 | No Playwright or browser components. |
| CAPTCHA/MFA handoff | Placeholder | No | No | No | — | No | No | 🔴 | 0 | Must pause and request user action, never bypass. |
| Question answering | No | Agent class | JSON questions | No | Yes | No extraction/replay | No | 🟠 | 15 | Prompt/rules exist, but no form or approval integration. |
| Submission verification | No | No | confirmation fields | No | — | No | No | 🔴 | 0 | No submit response/page/email verification. |
| Notifications | Hardcoded data | List/read API | Notification | No producer | — | Broken UI link | No | ⚠️ | 25 | Replace Header constants with API and event producers. |
| Live events | UI client | SSE route | AutomationEvent | No producer | — | Heartbeat only | No | 🟡 | 25 | `broadcastToUser` has no production caller and is process-local. |
| Dashboard metrics | Yes | Real queries | Existing rows | — | — | Read path | No | 🧪 | 55 | Metrics reflect rows, not verified submissions. |
| Analytics | Basic charts | Counts/timeline | Existing rows | — | — | Partial | No | 🟡 | 35 | Missing source/role/company/resume performance and SQL-scale aggregation. |
| Email tracking | No | No | No message model | No | — | No | No | 🔴 | 0 | OAuth/inbox parsing/linking absent. |
| Interviews/offers | No | No routes | Models | No | — | No | No | 🟠 | 15 | Schema only. |
| Audit logs | No | No writes | AuditLog | No | — | No | No | 🟠 | 10 | Model exists but routes/services do not write it. |
| Generic AI chat | Yes | Real provider call | No history | — | Yes | UI→API→provider | No | 🧪 | 60 | Useful assistant, not an action agent; add provider contract/security tests. |
| Object storage | No | No | Bytes/path fields | No | — | No | No | 🔴 | 0 | Resume bytes remain in PostgreSQL. |
| Redis/BullMQ | No | No | No | No | — | No | No | 🔴 | 0 | No dependency/config/producer/consumer. |

## User Configuration Field Matrix

Legend inside table: Y = exists; N = absent; P = partial. “Affects automation” is the decisive column.

| Field | UI | Model/API | Persists | Search | Match | Rules | Automation | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Country/state/city | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Remote/hybrid/on-site | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Target roles | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Experience/seniority | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Skills/technologies | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Salary preferences | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Employment type/industry | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Preferred/blocked companies | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Job sources | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Visa/work authorization | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Notice/availability | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Daily application limit | N | Y | Y | N | N | N | N | 🟠 Backend only |
| Automation mode | P | P | Y | N | N | N | N | 🟡 Record only; vocabularies drift |

## Master Resume Matrix

| Capability | Status | Evidence and gap |
|---|---|---|
| Upload/PDF/DOCX/TXT/text extraction | 🧪 65% | Multer + `pdf-parse` + `mammoth`; no integration tests or live DB. |
| Section detection/metadata | 🧪 50% | Regex headings and metadata stored in JSON. |
| Experience/skills/education/projects/certifications/languages extraction | 🔴 5% | Not normalized from resume into profile. |
| Preview | 🟡 25% | Uploaded master metadata listed; raw content preview absent. |
| Master flag | 🟡 40% | Boolean stored; no one-master invariant or management flow. |
| Editing | 🔴 0% | No edit endpoint/UI. |
| Persistent version creation/comparison | ⚠️ 20% | Prisma model exists; manager is disconnected process-local Map. |
| Download/PDF/DOCX generation | 🔴 0% | No endpoint or binary renderer. |
| Storage/object metadata | ⚠️ 20% | Raw bytes in DB; object storage absent. |
| Provenance | 🟠 20% | Agent returns model-authored source facts; no independent verifier. |

## Dashboard Page Matrix

| Expected page | UI | API/real data | Mutations/realtime | Status |
|---|---|---|---|---|
| Overview | Yes | Prisma metrics | Run-record toggle | 🟡 Partial |
| Jobs + inline detail | Yes | Real list/discover | Manual import | 🟡 Partial |
| Applications + inline detail | Yes | Real reads | No create/status UI | 🟡 Partial |
| Resume Studio | Yes | List/upload | No tailor/edit/download | 🟡 Partial |
| Automation Center | Yes | Run/event records | No workers | 🟡 Partial |
| Failed Applications/Review Room | Placeholder | None | None | 🔵 UI only |
| Analytics | Yes | Basic metrics/timeline | Read only | 🟡 Partial |
| Rules/Settings | Yes | Rule CRUD | Conditions unavailable | 🟡 Partial |
| AI Assistant | Sidecar | Real chat | No tools/actions | 🧪 Untested |
| Notifications | Dropdown | Hardcoded | Fake mark-read | ⚠️ Broken |
| ATS Scanner | No | No production API | No | 🔴 Missing |
| Search Profiles | No | Backend CRUD | No | 🟠 Backend only |
| Queue | Label only | Application reads | No workers | 🔴 Missing capability |
| Interview/Offer/Audit Logs | No | Models only | No | 🟠 Backend only |

## Broken Features and Severity

| Severity | Feature | Root cause | Impact | Fix |
|---|---|---|---|---|
| P0 | Automation semantics | Run status is not tied to work | Users can mistake a row for execution | Queue/worker control plane and accurate states |
| P0 | Application transitions | Free-form strings + route allowlist only | Invalid lifecycle and false analytics | Typed transition service, lock/version, history, outbox |
| P1 | Notifications | UI constants; API unconsumed | Fake operational events | API-backed UI and durable producers |
| P1 | Refresh flow | Client discards refresh token | Sessions expire without recovery | Secure rotation/storage strategy and client refresh |
| P1 | Seed | Package script targets missing file | Reproducible setup fails | Add reviewed idempotent seed or remove declaration |
| P1 | Contract drift | Shared enums differ from API values | Integration defects | Single generated contract and DB constraints |
| P1 | Live DB unavailable | No listener at configured URL | Database paths cannot run locally | Start safe PostgreSQL and apply versioned migrations |
