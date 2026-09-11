# Database Architecture

## Decision

Use PostgreSQL as the durable transactional system of record. Keep Prisma as the TypeScript query and migration layer, while allowing reviewed SQL migrations for PostgreSQL-specific capabilities. Add Redis/BullMQ for transient distributed coordination, pgvector for embeddings, and private S3-compatible object storage for binary artifacts. Do not add MongoDB unless a later, independently measured document workload cannot be served by PostgreSQL JSONB or a derived search index.

## Production Topology

```text
User browser
    │ TLS
    ▼
Load balancer / API gateway
    │
    ├──► stateless API replicas
    │       │
    │       ├──► PostgreSQL through PgBouncer
    │       │      OLTP + JSONB + FTS/trigram + pgvector
    │       │
    │       ├──► private object storage
    │       │      resumes / generated docs / screenshots / large logs
    │       │
    │       └──► Redis
    │              rate limits / cache / short leases
    │
    └──► authenticated SSE/WebSocket gateway

PostgreSQL outbox ──► relay ──► BullMQ queues in Redis
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
       discovery workers      AI workers        browser workers
              │                   │                    │
              └──────── durable results/events ───────┘
                                  │
                                  ▼
                              PostgreSQL

Optional derived systems at measured scale:
PostgreSQL outbox/CDC ──► OpenSearch (search) / warehouse (long analytics)
```

## Component Responsibilities

### PostgreSQL

Authoritative durable data:

- tenants, users, profiles and consent/privacy state;
- search profiles and rules;
- canonical companies, jobs, sources and discovery provenance;
- resumes, versions, facts and artifact metadata;
- versioned AI/ATS analyses and embeddings;
- matches and recommendations;
- applications, validated transitions, questions/answers, attempts and outcomes;
- automation runs/jobs, durable events, failures and human-verification requests;
- notification records, interviews, offers and append-only audit logs;
- transactional outbox and idempotency records.

Use JSONB for raw provider snapshots, sparse AI details and versioned output payloads. Promote fields used in policy, filters, joins and reporting to typed columns.

### Redis and BullMQ

Transient/distributed execution data only:

- queued work and delayed retries;
- worker heartbeat and short leases;
- per-source/per-user rate limits;
- distributed locks where PostgreSQL/advisory locks are not the better boundary;
- idempotency windows and dedupe hints;
- cached search/dashboard results;
- browser-worker coordination and ephemeral session routing.

Every handler is at-least-once safe. PostgreSQL state plus idempotency keys determines whether work already completed. Redis loss must not erase an application, attempt, audit record or final outcome.

### Object Storage

Private, encrypted buckets hold:

- source and generated PDF/DOCX resumes;
- generated cover letters and application packages;
- screenshots, HTML snapshots and submission receipts;
- large sanitized worker logs and exported archives.

PostgreSQL holds immutable object key/version, owner/tenant, checksum, MIME, byte size, encryption-key reference, malware-scan state, creation/expiry, legal hold and provenance. Access uses short-lived signed URLs. Never expose stable public URLs.

### Search and Vector Retrieval

Start inside PostgreSQL:

1. B-tree/composite indexes for structured eligibility filters.
2. `tsvector` plus GIN for descriptions/title/company keywords.
3. `pg_trgm` for fuzzy titles, skills and company names.
4. pgvector for job/resume/profile embeddings.
5. Structured prefilter → lexical/vector candidates → weighted reranking.

Add OpenSearch only when active corpus, query rate, faceting or typo/search relevance exceeds measured PostgreSQL targets. Populate it from an outbox/CDC stream and treat it as a rebuildable projection.

## Service Boundaries and Data Flow

### Job discovery

1. Scheduler publishes a durable discovery command through PostgreSQL outbox.
2. BullMQ worker claims it, checks source/user limits, and fetches an authorized ATS source.
3. Worker writes a discovery run and staged source items.
4. PostgreSQL transaction normalizes/upserts source identity and canonical jobs.
5. Analysis/matching commands are emitted through the same transaction's outbox.
6. Search projection refresh is asynchronous and rebuildable.

### Application lifecycle

```text
DISCOVERED → QUALIFIED → RESUME_GENERATED → ATS_VALIDATED → QUEUED
       └───────────────→ SKIPPED
QUEUED → APPLICATION_STARTED → FORM_FILLED → SUBMISSION_PENDING
                            └──→ WAITING_FOR_USER
                                 ├── CAPTCHA_REQUIRED
                                 └── MFA_REQUIRED
SUBMISSION_PENDING → SUBMITTED → CONFIRMED → INTERVIEW → OFFER → ACCEPTED
         └──────────→ FAILED → RETRY_PENDING ──→ APPLICATION_STARTED
CONFIRMED / INTERVIEW / OFFER ──→ REJECTED
```

A transition command locks or version-checks the Application row, validates an allowlisted transition, updates state/milestone fields, appends `ApplicationStatusTransition` and `AuditLog`, and inserts an outbox event in one transaction. The current state is a projection; immutable history explains how it was reached.

### Worker execution

- `AutomationRun` groups a user-authorized run.
- `AutomationJob` identifies a durable unit of work and BullMQ job ID.
- `ApplicationAttempt` identifies an idempotent browser attempt.
- Worker leases and transient progress live in Redis.
- Durable events and final results are written in PostgreSQL.
- HumanVerification suspends work without retaining sensitive CAPTCHA/MFA values longer than necessary.

## Recommended Logical Schema

### Identity and tenancy

- `Tenant(id, name, status, createdAt)`
- `TenantMember(tenantId, userId, role)`
- `User`, `UserProfile`, `ConsentRecord`, `PrivacyRequest`
- All owned tables carry `tenantId`; single-user accounts receive a personal tenant.

### Candidate profile

- `Resume`, `ResumeVersion`, `ResumeSourceFact`
- `Experience`, `Education`, `Project`, `Certification`
- `Skill`, `SkillAlias`, `ProfileSkill`
- `StoredObject`

### Jobs and intelligence

- `Company`, `JobSource`, `JobDiscoveryRun`, `JobDiscoveryItem`, `Job`
- `JobRequirement`, `JobSkill`
- `JobAnalysis(version, model, promptVersion, inputHash, output JSONB)`
- `JobMatch(userId, jobId, basisVersion, scores, explanation JSONB)`
- `Embedding(entityType, entityId, model, dimensions, contentHash, vector)`

### Applications

- `Application(version, currentStatus, userId, jobId, resumeVersionId, ...)`
- `ApplicationStatusTransition`
- `ApplicationAttempt`
- `ApplicationQuestion`, `ApplicationAnswer`
- `ApplicationDocument`, `CoverLetter`, `ATSAnalysis`
- `Interview`, `Offer`, `FailureRecord`, `HumanVerification`

### Automation and reliability

- `AutomationRun`, `AutomationJob`, `AutomationEvent`
- `BrowserSessionReference` (encrypted external reference, never raw browser secrets)
- `OutboxEvent`, `IdempotencyRecord`, `AuditLog`, `Notification`
- `ApplicationRule`, `SearchProfile`

## Index and Partition Baseline

- Job: unique source identity; partial active indexes; `(isActive, postedAt DESC)`; location/remote/salary composites based on query plans; GIN search vector; trigram title/company.
- JobMatch: `(userId, overall DESC, jobId)` and freshness/version fields.
- Application: unique `(tenantId,userId,jobId)`; `(userId,currentStatus,createdAt DESC)`; job/status and applied date.
- ResumeVersion: `(resumeId,generatedAt DESC)`, jobId, input hash.
- AutomationRun/Job: active partial uniqueness, queue/status/availableAt and lease-expiry indexes.
- AutomationEvent/AuditLog: monthly range partitions; `(tenantId,timestamp DESC)` and run/resource keys; retention and archival policy.
- Questions/answers: application/order/risk indexes; encrypt sensitive answers.
- Embeddings: entity/model uniqueness plus model-specific HNSW/IVFFlat index.

Indexes must follow measured query plans. Avoid indexing large JSONB indiscriminately.

## Multi-Tenant Isolation

1. Authenticate user and membership at the API boundary.
2. Begin a transaction and set a transaction-local tenant/user context.
3. Enable PostgreSQL RLS on every owned table.
4. Use tenant-aware unique and foreign keys where feasible.
5. Give API, worker, migration and reporting roles separate least privileges.
6. Workers receive explicit tenant context from durable AutomationJob records, never trusted queue payload alone.
7. Test cross-tenant reads/writes at database and API levels.

## Security and Privacy

- Managed PostgreSQL with TLS, private networking, restricted roles, secret-manager credentials, PITR and encrypted backups.
- PgBouncer transaction pooling sized independently for APIs and workers.
- KMS envelope encryption for private object storage and selected high-risk DB fields.
- Password hashes stay one-way; never store raw credentials or browser cookies in general JSON.
- Append-only security/audit events with actor, tenant, request, resource, action and redacted context.
- Data inventory classifies PII, sensitive application answers and authorization information.
- Retention policies cover jobs, events, screenshots, resumes, failed attempts and AI prompts.
- GDPR/privacy workflow supports export, deletion/anonymization, object deletion, derived index removal and auditable completion.
- Restore tests and incident response are deployment gates.

## Connection and Operational Policy

- Validate required configuration at startup and expose readiness separately from liveness.
- Use a bounded Prisma pool through PgBouncer; define statement/transaction timeouts.
- Gracefully stop HTTP intake, drain workers, release leases, flush outbox relay and disconnect Prisma.
- Apply versioned migrations in CI/CD; prohibit production `prisma db push`.
- Run migrations with a dedicated role and backward-compatible expand/migrate/contract releases.
- Monitor pool saturation, lock waits, slow queries, dead tuples, replication lag, queue lag, retry rate, partition size and object failures.

## Scaling Stages

### Up to 10,000 users

One managed PostgreSQL primary, PgBouncer, Redis, object storage and worker autoscaling. PostgreSQL search/vector is sufficient. Partition append-only events before they become large.

### Around 100,000 users

Read replicas for non-critical analytics, incremental aggregates, ingestion staging, stronger queue isolation by source/work type, cold event/object archive, and separate API/worker pool budgets. Limit match fan-out with candidate retrieval.

### Toward 1,000,000 users

Time-partition high-volume logs/events, stream analytical events to a warehouse, add derived OpenSearch if justified, and shard only after identifying a hot data dimension. Avoid all-user × all-job materialization. Keep application state and cross-entity invariants in PostgreSQL even if search/analytics become separate systems.

## Delivery Sequence

1. Start and introspect the current PostgreSQL database; establish migrations and backups.
2. Add constraints, transition history, outbox and idempotency without removing old fields.
3. Introduce object storage and verified binary backfill.
4. Add Redis/BullMQ and idempotent discovery/AI workers.
5. Add human-verification and browser-worker persistence boundaries.
6. Add PostgreSQL FTS/trigram and then pgvector with offline relevance evaluation.
7. Add RLS/tenant keys and privacy/audit workflows before multi-tenant production.
8. Partition/warehouse/search-engine additions only from measured production demand.

## Explicit Non-Decisions

- MongoDB is not part of the initial or recommended primary architecture.
- Redis is not a source of truth.
- Object bytes do not belong in ordinary PostgreSQL rows.
- Search indexes and warehouses are derived, rebuildable systems.
- The database does not make browser automation safe or compliant; user authorization, review boundaries and external-site policy remain product requirements.
