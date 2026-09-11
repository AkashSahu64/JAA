# Database Audit

## 1. Executive Summary

**Decision:** retain PostgreSQL as the primary system of record. The project already implements PostgreSQL through Prisma; MongoDB is neither configured nor used. The schema is substantial, but the database is not currently operational in this environment because nothing is listening on `localhost:5432`. Prisma Client generation, TypeScript, tests, and builds pass, while a prior safe connection attempt returned Prisma `P1001`.

The correct target is **PostgreSQL + Prisma + pgvector + Redis/BullMQ + S3-compatible object storage**. PostgreSQL owns durable business state and relationships. Redis owns queues, leases, rate limits, and short-lived coordination. Object storage owns binary artifacts. A dedicated search engine is optional only after PostgreSQL full-text/trigram/vector search reaches measured limits.

Current overall readiness is **59/100**: a credible relational foundation, not a production-ready autonomous worker platform. The largest gaps are absent migrations/seeds, no live database, free-form state strings, binary resumes in rows, incomplete entity normalization, no queue/worker system, no RLS, weak lifecycle/audit coverage, and no implemented browser automation.

## 2. Current Database

| Question | Verified answer |
|---|---|
| Database | PostgreSQL, declared by Prisma datasource (`packages/database/prisma/schema.prisma:5-8`) |
| Actually connected now? | No. No local PostgreSQL service, `psql`, Docker command, or listener on port 5432 was available; prior `db:push` reached `P1001` |
| ORM/query layer | Prisma Client (`packages/database/src/index.ts:1-13`) |
| MongoDB | No Mongoose/MongoDB driver, configuration, model, or query usage found |
| Redis/BullMQ | Not implemented; no runtime dependency or application use found |
| Local database | PostgreSQL 16 Alpine in Compose, port 5432, persistent volume (`compose.yaml:1-20`) |
| Production database | `DATABASE_URL` only; no checked-in production topology, proxy, SSL, replica, or pool policy |
| Test database | Not configured |
| Migrations | Prisma commands exist, but no migration directory/files exist |
| Seed | No seed script or seed data exists |

## 3. Current Database Configuration

`DATABASE_URL` is required by `.env.example:1-2` and consumed by Prisma. The committed example contains placeholders only. A local `.env` exists and was not inspected or reproduced in this report. Compose supplies a development-only PostgreSQL instance. Prisma CLI commands are rooted at `packages/database/prisma/schema.prisma` (`package.json:13-16`).

The Prisma singleton caches one client in non-production to avoid hot-reload duplication and enables query logging in development (`packages/database/src/index.ts:5-13`). Prisma owns its normal connection pool, but there is no explicit pool sizing, PgBouncer mode, startup readiness probe, graceful `$disconnect`, retry/backoff, read replica, statement timeout, or production TLS enforcement in application code.

## 4. ORM/ODM

Prisma is both schema authority and query layer. The API imports a shared singleton and directly issues typed CRUD queries. There is no repository/unit-of-work layer and no second ORM/ODM. Prisma is appropriate here, but production features that require PostgreSQL-specific DDL—RLS, partial indexes, check constraints, extensions, generated search vectors, partitioning—will need SQL migrations rather than `db push` alone.

## 5. Existing Models and Tables

The schema defines **20 mapped PostgreSQL tables**, all UUID-string primary keys unless noted. No Prisma enums or database check constraints exist; many domains are unconstrained `String` values.

| Table/model | Fields (actual schema) | Keys, indexes, deletion behavior |
|---|---|---|
| `users` / User | id; email; passwordHash; name; createdAt; updatedAt; lastLoginAt?; isActive | email unique; parent of most user data |
| `user_profiles` / UserProfile | id; userId; fullName; email; phone?; country/state/city?; links; otherLinks? JSON; currentRole?; yearsOfExperience; targetRoles[]; seniority?; summary/objective?; experience/education/certifications/skills/projects/languages JSON; authorization fields; salaryPreference? JSON; locationPreferences JSON; notice/availability/additionalData? | userId unique FK → User, cascade |
| `search_profiles` / SearchProfile | id; userId; name; geography arrays; role/seniority/skill/technology arrays; experience/salary ranges; employment/industry/company/source arrays; thresholds; daily cap; schedule; customCron?; isActive; timestamps | FK → User, cascade; **no userId/name or active index** |
| `resumes` / Resume | id; userId; name; isMaster; content; rawFile? Bytes; fileName?; mimeType?; parsedData? JSON; timestamps | FK → User, cascade; **no userId index or one-master constraint** |
| `resume_versions` / ResumeVersion | id; resumeId; jobId?; company?; role?; jdHash?; content; htmlContent?; ATS score/data JSON; keywordCoverage; changes/sourceFacts JSON; filePath?; generatedAt | FK → Resume cascade; optional FK → Job default restrict; **no resumeId/generatedAt or job index** |
| `jobs` / Job | id; source; sourceJobId?; company/title/normalizedTitle; location/remoteType; description; requirement/responsibility/skill arrays; salary fields; employment/seniority/experience; posted/expires; URLs; fingerprint; duplicate group/count; isActive; timestamps | unique(source, sourceJobId); indexes company, normalizedTitle, location, postedAt, fingerprint, duplicateGroupId, isActive |
| `job_analyses` / JobAnalysis | id; jobId; summary; must/nice/optional/stack/signal arrays; leadership; communication/domain/team; methodology/benefit/red-flag arrays; analyzedAt | jobId unique FK → Job, cascade |
| `job_matches` / JobMatch | id; jobId; userId; overall plus 11 component scores; tier; matched/missing arrays; notes; calculatedAt | unique(jobId,userId); index(userId,overall); job cascade; **userId has no FK** |
| `applications` / Application | id; userId; jobId; resumeVersionId; coverLetterId?; status/submissionStatus; scores/quality JSON; milestone dates/failure/retries; questions JSON; notes/confirmation; automationRunId?; timestamps | unique(userId,jobId); indexes status, (userId,status), appliedAt; User cascade; other FKs default restrict |
| `application_attempts` / ApplicationAttempt | id; applicationId; attemptNumber; status; start/end/error; detected/filled counts; screenshot? path; logs JSON | FK → Application, cascade; **no unique(applicationId,attemptNumber), no time index** |
| `application_documents` / ApplicationDocument | id; applicationId; type; fileName/path/MIME; uploadedAt | FK → Application, cascade; **no application/time index** |
| `cover_letters` / CoverLetter | id; userId; jobId; company; role; content; style; generatedAt | User cascade, Job cascade; **no ownership/job index** |
| `automation_runs` / AutomationRun | id; userId; status; mode; activeKey?; counters; errors JSON; start/stop | activeKey unique; index(userId,status); User cascade |
| `automation_events` / AutomationEvent | id; runId; type; jobId? scalar; message; data? JSON; timestamp | FK → Run cascade; index(runId,timestamp); jobId is not an FK |
| `notifications` / Notification | id; userId; type/title/message/data; read; createdAt | FK → User cascade; index(userId,read), but not ordered time |
| `companies` / Company | id; name; normalizedName; industry/size/location/URLs; jobCount; hiringActivity; technologies[]; updatedAt | normalizedName unique; **not related to Job** |
| `user_rules` / UserRule | id; userId; name; enabled; conditions JSON; action; priority; timestamps | FK → User cascade; **no (userId,enabled,priority) index** |
| `audit_logs` / AuditLog | id; userId; action/resource/resourceId/details/IP/timestamp | User cascade; indexes(userId,timestamp), (resource,action); model currently unused by routes |
| `interviews` / Interview | id; applicationId; userId; date/type/company/role/round/interviewer/meeting/notes/preparation/result; timestamps | Application cascade; User default restrict; **no user/date index** |
| `offers` / Offer | id; applicationId; userId; company/role/compensation/benefits/dates/status/notes; timestamps | Application cascade; User cascade; indexes(userId,status), applicationId |

Defaults are defined in `packages/database/prisma/schema.prisma:10-541`. Nullable fields use `?`; arrays generally default to empty; JSON defaults use JSON literals encoded in Prisma strings. PostgreSQL foreign keys use cascade only where explicitly listed above. There are **no SQL enums, check constraints, decimal money types, soft-delete timestamps, tenantId, row-version columns, or createdAt on Company**.

## 6. Entity Coverage

| Conceptual entity | Status | Actual representation / redesign need |
|---|---|---|
| User, UserProfile, SearchProfile | Existing | Profile contains many JSON aggregates; normalize reusable/queryable facts |
| Resume, ResumeVersion | Existing | Raw binary should move to object storage; version manager also has a disconnected in-memory implementation (`packages/resume-engine/src/version-manager.ts:26-71`) |
| ResumeSourceFact | Partial | JSON `ResumeVersion.sourceFacts`; normalize for provenance/audit queries |
| Skill, Experience, Education, Project, Certification | Partial | TypeScript interfaces exist, persisted only inside profile JSON |
| Job | Existing | Strong core, but missing Company/JobSource links and robust search/dedupe constraints |
| JobSource, JobDiscovery | Missing/partial | Source is a string; discovery returns an ephemeral runId but persists no run/source record |
| JobAnalysis | Existing | One mutable analysis/job; add model/version/provider/prompt provenance |
| JobMatch | Existing | Missing User FK and resume/profile/version basis |
| JobRequirement, JobSkill | Partial | Arrays on Job/JobAnalysis; normalize if ranking/filtering/reporting matters |
| Company | Existing but disconnected | Jobs duplicate company name; Company receives no relations or API use |
| CompanyInsight | Partial | Company has limited insight fields; user-specific prior application count is absent |
| Application | Existing | Core ownership/dedupe exists; states are strings and transition history is absent |
| ApplicationAttempt | Existing | Needs uniqueness, worker/job linkage, idempotency, leases, timestamps, failure classification |
| ApplicationQuestion/Answer | Partial | Combined unvalidated JSON array on Application |
| ApplicationDocument | Existing | Path metadata only; needs object key, checksum, size, encryption/version metadata |
| CoverLetter | Existing | No API persistence path found |
| ATSAnalysis / ATSScore | Partial | ATS JSON and scalar score on ResumeVersion/Application; no versioned analysis entity |
| AutomationRun | Existing | API only stores lifecycle/counters; no actual worker orchestration |
| AutomationJob / ApplicationQueue | Missing | UI calls applications a queue, but no durable queue entity or Redis queue exists |
| AutomationEvent | Existing | Useful append log, but no retention/partitioning or event sequence/idempotency |
| ApplicationRule | Existing as UserRule | Conditions/actions are flexible JSON/string and type/API action vocabularies disagree |
| Notification, Interview, Offer, AuditLog | Existing | Interview/Offer/AuditLog lack active API persistence paths; AuditLog unused |
| CredentialReference | Missing | Credential vault is an encrypted process-local Map (`packages/security/src/credential-vault.ts:13-66`) |
| BrowserSession, HumanVerification, FailureRecord | Missing | No browser worker or CAPTCHA/MFA handoff implementation |

## 7. Relationships

```text
User ─1:1─ UserProfile
  ├─1:N─ SearchProfile
  ├─1:N─ Resume ─1:N─ ResumeVersion ─0:N─ Application
  ├─1:N─ Application ─1:N─ Attempt / Document / Interview / Offer
  ├─1:N─ AutomationRun ─1:N─ AutomationEvent
  ├─1:N─ Notification / UserRule / AuditLog / CoverLetter
  └─1:N─ JobMatch (logical only; schema lacks User FK)

Job ─1:1─ JobAnalysis
  ├─1:N─ JobMatch
  ├─1:N─ ResumeVersion
  ├─1:N─ Application
  └─1:N─ CoverLetter

AutomationRun ─0:N─ Application ─1:N─ ApplicationAttempt
Company   (currently isolated; Job.company is duplicated text)
```

Important invariants: one profile/user; one analysis/job; one match/job/user; one application/job/user; one active automation key/user. Application requires a resume version and ties all attempts/documents/outcomes together. However, no database rule proves an application's ResumeVersion, CoverLetter, AutomationRun, and User belong to the same user. This cross-owner invariant must be transactionally validated or redesigned with tenant-aware composite keys.

## 8. Current Architecture and Data Characteristics

**Structured/relational:** PostgreSQL handles users, jobs, matches, applications, outcomes, dates, and scores naturally. Foreign keys exist for most paths, but not JobMatch.userId or event.jobId.

**Semi-structured:** JSON is sensible for raw provider payloads, versioned AI output, score explanations, rule ASTs, and sparse metadata. It is overused for core profile facts, questions/answers, provenance, and errors that need querying, lifecycle, or referential integrity.

**High-volume:** global jobs and per-user applications fit PostgreSQL. AutomationEvent and attempt/log growth need partitioning/retention and object/log storage. Current events are a single unpartitioned table; logs/errors are JSON rows.

**Search:** current API uses case-insensitive `%substring%` matching over title/company/description (`apps/api/src/routes/jobs.ts:27-34`), which cannot use ordinary B-tree indexes effectively. There is no FTS, trigram, GIN, vector, or dedicated search service.

**Analytics:** simple counts/averages work, but the dashboard runs 10 counts plus later aggregates (`apps/api/src/routes/analytics.ts:19-40`). Timeline fetches every application row for up to 365 days and groups in Node (`apps/api/src/routes/analytics.ts:74-90`). SQL aggregation/materialized rollups will scale better.

## 9. Current Problems

1. Database is not running here, and schema has not been verified against a live instance.
2. No migrations or seed/test database: `db push` cannot provide audited production evolution.
3. Free-form status/mode/type/action strings allow impossible values and unrestricted transitions.
4. No transactional state-transition service or immutable transition history.
5. Resume binaries are stored in `Resume.rawFile` despite `STORAGE_PATH` being unused (`apps/api/src/routes/resumes.ts:46-59`).
6. Company, AuditLog, Interview, Offer, CoverLetter and several AI-agent outputs are schema-only or incompletely wired.
7. Application creation, queue, worker, browser session and human verification are absent.
8. Multi-tenancy is application-filtered only; no tenant entity or PostgreSQL RLS.
9. PII and resume text/binary are not field/envelope encrypted in the database.
10. Type contracts drift from API/schema: e.g. ApplicationStatus and AutomationMode values differ (`packages/types/src/index.ts:3-34`; route sets in applications/automation).

## 10. Performance Audit

**Positive:** job/application endpoints paginate and count concurrently; job matching and application uniqueness constraints prevent common duplicates; ownership filters are generally present; notification/event limits are bounded.

**Concrete findings:**

- Job discovery serially awaits one upsert per result (`apps/api/src/routes/jobs.ts:113-121`). Use batched bounded concurrency or staging + set-based merge; keep unique idempotency.
- Search ORs three unindexed substring scans (`jobs.ts:27-34`). Add generated `tsvector` + GIN, `pg_trgm` indexes for fuzzy title/company, and structured filters.
- `@@unique([source, sourceJobId])` permits multiple rows where `sourceJobId` is null under PostgreSQL semantics. Current adapters assert a value, but database integrity does not. Use non-null sourceJobId or a partial/fingerprint strategy.
- `Float` salary is imprecise. Use integer minor units or `Decimal`, currency, and normalized annual amount.
- Job list returns full descriptions and analysis for up to 100 rows (`jobs.ts:37-48`); use a summary projection and detail endpoint.
- Resume list loads all versions nested per resume without a cap (`resumes.ts:82-97`); add pagination/latest-N.
- Search profiles and resume list lack owner/order indexes.
- Application status update is update then re-read without a transaction (`applications.ts:88-100`) and allows arbitrary transitions.
- Automation check-then-create races at application level, although `activeKey` uniqueness correctly closes duplicate-active creation (`automation.ts:33-54`). Transition selection/update itself lacks optimistic concurrency.
- No `ApplicationAttempt(applicationId, attemptNumber)` uniqueness permits duplicate attempts.
- Timeline aggregation occurs in application memory. Push `date_trunc` grouping into SQL.
- Dashboard's repeated counts are acceptable initially but should become one conditional aggregate or rollup at scale.
- There is no N+1 query in the main paginated list paths; Prisma includes generate bounded relation queries. The most material issue is over-fetching, not classical N+1.

## 11. Security Audit

**Strengths:** database URL and cryptographic secrets are environment variables; passwords are hashed; request ownership filters are common; resume upload validates extension/MIME and caps 10 MB; raw resume bytes are omitted from API responses; AES-256-GCM utilities exist.

**Risks:**

- PostgreSQL credentials/SSL/pool hardening are deployment-dependent and undocumented beyond a local placeholder.
- Database contains email, phone, location, employment history, authorization/visa status, resumes, application answers, salary, IP addresses and interview data. There is no database/object-storage encryption policy, retention schedule, consent record, export/deletion workflow, or data classification.
- User deletion cascades erase many records immediately; there is no soft deletion/legal hold/tombstone/audited GDPR workflow. Conversely, Jobs are global and may persist indefinitely.
- No RLS means one missed `userId` filter can expose another user's data. The detail routes reviewed filter user-owned relations, but defense in depth is absent.
- No audit writes were found despite an AuditLog table.
- CredentialVault encryption is sound at utility level, but storage is process-local, non-durable, unaudited, and not user-bound.
- Storing resume binaries in normal rows increases blast radius, backups, memory use, and accidental access risk.
- Application JSON questions may contain sensitive demographic, authorization, salary, or disclosure answers without field-level policy.

Recommended controls: least-privilege DB roles, mandatory TLS, managed KMS/envelope encryption for object data and selected sensitive fields, RLS with transaction-scoped tenant/user identity, append-only audit events, secret manager, private object buckets with short signed URLs, checksums/malware scanning, retention/deletion workflows, PITR backups, and restoration drills.

## 12. Scalability Audit

**10,000 users:** one managed PostgreSQL primary plus read replica when justified, PgBouncer, Redis/BullMQ, object storage, and proper indexes is sufficient. Partition AutomationEvent early by month.

**100,000 users:** separate API and worker pools; queue backpressure; job ingestion staging; declarative partitions for events/attempt logs; read replicas for analytics; materialized/incremental metrics; archive cold events; monitor autovacuum/index bloat and hot indexes. Global Job dedupe and per-user JobMatch cardinality—not Users—become major costs.

**1,000,000 users:** avoid precomputing every user×job match. Generate candidate sets first, calculate top-K matches asynchronously, expire stale matches, and partition/shard by stable keys only when measured. Tens/hundreds of millions of events should be time-partitioned with retention/archival, potentially streamed to an analytical warehouse. PostgreSQL can remain the transactional source; Citus/sharding or service decomposition is a later measured decision.

MongoDB would simplify horizontal document sharding only if records were largely independent. Here, cross-entity uniqueness, ownership, state transitions, reporting, and consistency remain dominant. MongoDB does not remove queue, search, archive, or analytics architecture requirements.

## 13. AI Data Requirements

Use **relational columns** for fields that drive filters, joins, constraints, ordering, policy, or analytics: score, model/provider, analysis version, status, experience bounds, salary, location, remote type, timestamps, confidence, risk level and entity IDs.

Use **JSONB** for raw provider snapshots, model-specific details, explanation trees, warnings, sparse extracted attributes and backward-compatible output payloads. Every AI analysis should include schemaVersion, model, provider, prompt/template version, input hash, createdAt, confidence, validation status and raw JSON. Promote frequently queried JSON keys to typed columns.

Normalize Skill/JobSkill/ProfileSkill and questions/answers when cross-record matching, validation, consent, and reporting are required. Normalize ResumeSourceFact because generated claims need provenance. Keep immutable original extraction/analysis payloads in JSONB for reproducibility.

Index JSONB selectively with GIN; do not blanket-index large output blobs. Use B-tree composites for operational filters and HNSW/IVFFlat pgvector indexes for embeddings after enough data exists to justify them.

## 14. Search Requirements

The query “React developer, Bangalore, 1–3 years, salary above X, remote/hybrid, last 24h, match >85, ATS >90, not applied/rejected, company not blocked” is naturally relational:

- structured predicates on Job;
- join/EXISTS on user-scoped JobMatch;
- anti-join/NOT EXISTS on Application;
- anti-join against excluded companies;
- resume/application ATS criteria;
- deterministic ordering and pagination.

PostgreSQL expresses this in one query with transactional consistency. MongoDB can implement it with aggregation/$lookup or denormalized per-user documents, but keeping denormalized state synchronized is the harder system.

Initial search stack: PostgreSQL B-tree/composite indexes + `tsvector`/GIN + `pg_trgm` + pgvector. Candidate generation should combine structured filters, text rank and vector similarity, then rerank. At sustained tens of millions of active jobs, high QPS, complex facets, typo tolerance and independent search scaling, add OpenSearch/Elasticsearch as a derived index via outbox/CDC—not as the source of truth.

## 15. PostgreSQL vs MongoDB

Scores reflect this product and assume competent managed deployments. “Operational complexity” scores the easier/better fit, so higher is preferable.

| Category | PostgreSQL | MongoDB | Product-specific reason |
|---|---:|---:|---|
| Data relationships | 10 | 6 | Application graph is deeply relational |
| Transactions | 10 | 8 | Multi-record transitions/outbox are routine in SQL |
| Referential integrity | 10 | 5 | FKs/cascades/composites matter |
| Job/application relationships | 10 | 6 | Joins and anti-joins are core |
| Resume versioning | 9 | 8 | Both work; SQL preserves references better |
| Application state machines | 10 | 7 | Constraints, locks, transactional history |
| Job deduplication | 9 | 8 | Unique/expression/partial indexes |
| Search | 8 | 9 | Atlas Search is polished; PG is enough initially |
| Filtering | 10 | 8 | Multi-dimensional relational filters |
| Analytics | 10 | 7 | SQL/grouping/window functions |
| Reporting | 10 | 7 | BI ecosystem and joins |
| AI-generated JSON | 9 | 10 | JSONB narrows Mongo's flexibility advantage |
| Flexible schemas | 8 | 10 | Mongo wins, but flexibility needs governance |
| Schema migrations | 9 | 7 | Explicit SQL migrations are safer here |
| Indexing | 10 | 9 | PG has broad specialized indexes |
| Full-text search | 8 | 9 | Atlas Search stronger out of box |
| Vector search | 9 | 9 | pgvector and Atlas both viable |
| Concurrent workers | 10 | 8 | row locks, SKIP LOCKED, advisory locks |
| Queue integration | 9 | 9 | Both pair with Redis; DB is not the queue |
| Background jobs | 9 | 8 | transactional outbox is straightforward |
| Scaling | 8 | 9 | Mongo shards earlier/easier; PG scales far enough |
| Data consistency | 10 | 8 | relational invariant advantage |
| Debugging | 9 | 8 | SQL plans, constraints, mature tooling |
| Developer experience | 9 | 9 | Prisma supports both; current code already Prisma/PG |
| TypeScript support | 9 | 9 | strong on both |
| Prisma support | 10 | 8 | PostgreSQL feature coverage is broader |
| Operational simplicity | 8 | 8 | managed offerings comparable; hybrid needs neither Mongo |
| Cost efficiency | 9 | 8 | one PG handles OLTP/search/vector initially |
| Backup/recovery | 10 | 9 | mature PITR/logical/physical options |
| Security | 10 | 9 | RLS and granular roles are especially useful |
| Audit logging | 10 | 7 | append-only relational audit/outbox |
| Multi-tenant SaaS | 10 | 7 | RLS and tenant composite keys |
| Future AI/RAG | 9 | 9 | both vector-capable; relational context favors PG |
| Millions of jobs | 9 | 9 | both work with indexing/partitioning |
| Millions of events | 8 | 9 | Mongo write scaling edge; PG partitioning is adequate |
| **Unweighted total** | **323/350 (9.23)** | **284/350 (8.11)** | |
| **Weighted product-fit score** | **92/100** | **78/100** | relationships, integrity, state and analytics weighted highest |

MongoDB is a capable database; it is simply not the best primary source of truth for this workload. Adding it now would create dual persistence and synchronization without solving the missing queue, files, workers or lifecycle controls.

### Embeddings

Prefer **PostgreSQL + pgvector** initially: embeddings stay transactionally linked to Job, ResumeVersion, Profile snapshot and model version; structured prefilters and tenant boundaries remain in one query; operations remain one database. Store multiple embeddings in a dedicated table keyed by entity type/id, model, dimensions and content hash—not one opaque vector on every row. Use HNSW for latency-focused approximate retrieval and exact evaluation during tuning.

MongoDB Vector Search becomes attractive only if Atlas is already the operational standard or the retrieval corpus is predominantly independent documents. Neither is true in this codebase.

## 16. Current Database Scorecard

| Dimension | Score | Basis |
|---|---:|---|
| Architecture | 68/100 | right primary DB/ORM, incomplete production topology |
| Schema | 64/100 | broad domain coverage, weak constraints/normalization |
| Performance | 58/100 | pagination and indexes exist; search/analytics/ingest gaps |
| Scalability | 55/100 | no partitioning, queue, archive or matching strategy |
| Security | 58/100 | ownership/auth basics; no RLS, durable vault or PII policy |
| Maintainability | 62/100 | centralized schema/client; no migrations and type drift |
| AI readiness | 60/100 | JSON structures exist; no provenance/version/vector schema |
| Search capability | 38/100 | substring search only |
| Analytics capability | 52/100 | basic metrics only; application-side grouping |
| **Overall Database Readiness** | **59/100** | weighted assessment, with live connectivity unverified |

## 17. Recommended Architecture

```text
Browser / Web UI
       │ HTTPS + user token
       ▼
API service ───────────────► private S3-compatible storage
       │ transaction            resumes, PDFs, screenshots
       │                         encrypted objects + metadata
       ▼
PostgreSQL + Prisma
OLTP, tenants, jobs, applications, analyses, audit, outbox, pgvector
       │ committed outbox events
       ▼
Outbox relay ──► Redis / BullMQ ──► discovery / AI / browser workers
                                      │ status + durable results
                                      └────────► PostgreSQL

PostgreSQL change/outbox stream ──► optional search index / warehouse
                                    only when measured scale requires it
```

Redis must hold queue messages, retry scheduling, short leases, distributed locks, rate limits, cache, idempotency windows and browser-worker coordination. Durable outcomes, attempts and state transitions return to PostgreSQL. Redis is never the authoritative application database.

Object storage holds original/generated resumes, DOCX/PDF, cover letters, screenshots, HTML snapshots and large logs. PostgreSQL stores owner/tenant, object key, version, checksum, MIME, size, encryption key reference, scan status, retention and provenance. Buckets are private; access uses short-lived signed URLs.

## 18. Recommended Schema

Keep and evolve the present schema rather than replace it. Priority redesign:

1. Add `Tenant`/`TenantMember` if team SaaS is real; otherwise establish user-scoped RLS now. Put `tenantId` on every owned row and include it in unique/index/FK strategies.
2. Add database enums or lookup/check-constrained domains for application state, run state, attempt state, document type and rule action.
3. Add `ApplicationStatusTransition` (from, to, actor, reason, idempotencyKey, timestamp) and a transition service using transactions/optimistic versioning.
4. Add `AutomationJob` with queueName, jobType, entityId, status, priority, attempts, leaseOwner/expiry, idempotencyKey, availableAt and BullMQ ID; add `OutboxEvent`.
5. Add `JobSource`, `JobDiscoveryRun`, `JobDiscoveryItem`, and source payload/hash/provenance. Link `Job.companyId` to Company.
6. Normalize `ApplicationQuestion` and `ApplicationAnswer`; include risk, confidence, source fact, approval and encryption classification.
7. Add `HumanVerification` and `BrowserSessionReference`; never persist browser secrets/cookies unencrypted in ordinary JSON.
8. Add `FailureRecord` with category, code, retryability, sanitized detail and artifact references.
9. Add versioned `ATSAnalysis` and AI analysis metadata. Keep detailed output JSONB, promote scores/warnings used in filters.
10. Add `ResumeSourceFact`, optionally normalized Experience/Education/Project/Certification/ProfileSkill. Use canonical Skill + aliases and JobSkill/ProfileSkill join tables where match/search needs them.
11. Replace `rawFile` and path strings with `StoredObject`/`ApplicationArtifact` metadata to private object storage.
12. Add `Embedding` keyed by entity/model/content hash and a pgvector column; enforce dimensions per model strategy.
13. Add search vector/trigram indexes and operational composites: jobs active/posted/location/remote/salary; application user/status/time; resume user/time; events partition/time; rules user/enabled/priority.
14. Use BIGINT identity/sequence or UUIDv7 for very high-volume append tables to improve index locality; retain UUIDs for externally visible entities.

## 19. Migration Plan

No database replacement is recommended, so this is an **in-place PostgreSQL hardening migration**, not PostgreSQL→MongoDB.

**Phase 1 — schema mapping.** Generate a live schema dump, row counts, null/duplicate/orphan reports, size/index statistics and data classification. Compare production to Prisma. Freeze undocumented `db push` use.

**Phase 2 — new schema.** Write reviewed Prisma + SQL migrations for enums/constraints, new normalized tables, tenant/RLS, object metadata, outbox, queue references, partitions and search/vector extensions. Prefer additive nullable changes first.

**Phase 3 — migration scripts.** Build idempotent, resumable backfills with checkpoints and dry-run reports. Map legacy JSON/status values explicitly; quarantine malformed records rather than dropping them.

**Phase 4 — data migration.** Backfill company links, status history, normalized questions/facts and analysis metadata. Copy resume bytes to object storage; verify checksum, MIME, ownership and encryption before setting object references. Do not clear `rawFile` yet.

**Phase 5 — dual-read/verification.** Shadow-read old/new representations and compare counts, hashes, ownership, score values and random samples. Dual-write only where necessary; prefer transactional one-write plus derived backfill to avoid divergence.

**Phase 6 — application migration.** Move API reads/writes to repositories/services, transactional transition commands, outbox and object storage. Introduce Redis/BullMQ workers with idempotent handlers.

**Phase 7 — testing.** Migration tests on a production-like snapshot; FK/constraint tests; tenant isolation/RLS tests; concurrency/idempotency tests; restore drills; load tests for search, ingest, events and dashboards.

**Phase 8 — cutover.** Pause affected writers, drain queues, run final delta, verify checksums/invariants, deploy readers then writers, monitor errors/lag/locks. Keep old columns read-only.

**Phase 9 — rollback.** Feature flags revert reads; stop new workers; retain reversible mappings and old binary data for a defined window; restore from PITR only for catastrophic failures. Drop old fields only after acceptance and backup expiry.

**Data-loss risks:** malformed JSON, conflicting free-form statuses, orphan-like scalar IDs, duplicate nullable source IDs, cross-user references, binary transfer failures, truncated logs, timezone/date transformations and dual-write divergence. Every destructive cleanup requires verified counts/checksums and a restore point.

## 20. Risks

- The report describes the declared schema, not a live introspection, because the configured database is unavailable.
- Adding constraints may fail on unknown existing data; audit before enforcement.
- RLS can break background jobs unless worker roles and tenant context are designed explicitly.
- Partitioning and pgvector require operational expertise and query-plan measurement.
- Redis/BullMQ adds at-least-once delivery; handlers must be idempotent and durable state transitions transactional.
- Autonomous submission has legal, consent, anti-abuse and external-site policy risks beyond database design.
- AI outputs are untrusted; schema validation, provenance and human-review policy remain mandatory.

## 21. Final Decision

**For this autonomous Job Application Agent, use PostgreSQL—not MongoDB—as the primary database.** Continue the existing PostgreSQL/Prisma direction and migrate the schema forward through versioned migrations. Add JSONB for flexible AI/provider payloads, pgvector for semantic retrieval, Redis/BullMQ for transient orchestration, and S3-compatible storage for files. MongoDB adds no justified capability at this stage and would weaken the natural relational model or force synchronization across two primary stores.

### Concise answer

- **CURRENT DATABASE:** PostgreSQL 16 target; configured but not running/connected in this environment
- **ORM/ODM:** Prisma Client 5.x
- **CURRENT DATABASE READINESS:** 59/100
- **POSTGRESQL SCORE:** 92/100 weighted product fit
- **MONGODB SCORE:** 78/100 weighted product fit
- **RECOMMENDED DATABASE:** PostgreSQL
- **WHY:** relational integrity, transactional application state, anti-joins/filtering, analytics, RLS, JSONB and pgvector align with the actual workload and current code
- **MIGRATION REQUIRED:** no engine replacement; yes, controlled in-place schema/infra migration and data backfill
- **MIGRATION RISK:** medium, potentially high if unknown live data exists; additive phases and checksum verification reduce it
- **RECOMMENDED FINAL ARCHITECTURE:** Frontend → API → PostgreSQL/Prisma + pgvector → transactional outbox → Redis/BullMQ → idempotent AI/discovery/browser workers; private S3-compatible object storage; optional derived search/warehouse later
