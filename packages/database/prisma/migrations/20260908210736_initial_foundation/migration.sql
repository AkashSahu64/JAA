-- PostgreSQL foundation extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DISCOVERED', 'QUALIFIED', 'SKIPPED', 'RESUME_GENERATED', 'RESUME_VALIDATED', 'ATS_VALIDATED', 'QUEUED', 'APPLICATION_STARTED', 'FORM_FILLED', 'WAITING_FOR_USER', 'READY_TO_SUBMIT', 'SUBMISSION_PENDING', 'SUBMITTED', 'UNCONFIRMED', 'CONFIRMED', 'FAILED', 'RETRY_PENDING', 'INTERVIEW', 'REJECTED', 'OFFER', 'ACCEPTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "AutomationMode" AS ENUM ('ASSISTED', 'SMART_AUTO', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "AutomationStatus" AS ENUM ('IDLE', 'RUNNING', 'PAUSED', 'STOPPED', 'EMERGENCY_STOPPED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'AVAILABLE', 'LEASED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "locationCountry" TEXT,
    "locationState" TEXT,
    "locationCity" TEXT,
    "linkedIn" TEXT,
    "github" TEXT,
    "portfolio" TEXT,
    "otherLinks" JSONB,
    "currentRole" TEXT,
    "yearsOfExperience" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seniority" TEXT,
    "professionalSummary" TEXT,
    "careerObjective" TEXT,
    "experience" JSONB NOT NULL DEFAULT '[]',
    "education" JSONB NOT NULL DEFAULT '[]',
    "certifications" JSONB NOT NULL DEFAULT '[]',
    "skills" JSONB NOT NULL DEFAULT '{}',
    "projects" JSONB NOT NULL DEFAULT '[]',
    "languages" JSONB NOT NULL DEFAULT '[]',
    "workAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "visaRequired" BOOLEAN NOT NULL DEFAULT false,
    "visaType" TEXT,
    "sponsorshipNeeded" BOOLEAN NOT NULL DEFAULT false,
    "securityClearance" TEXT,
    "salaryPreference" JSONB,
    "locationPreferences" JSONB NOT NULL DEFAULT '[]',
    "noticePeriod" TEXT,
    "availability" TEXT,
    "additionalData" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "states" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remoteTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "seniority" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "experienceMin" INTEGER,
    "experienceMax" INTEGER,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salaryMin" DOUBLE PRECISION,
    "salaryMax" DOUBLE PRECISION,
    "salaryCurrency" TEXT,
    "employmentTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "industries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "preferredCompanies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minMatchScore" INTEGER NOT NULL DEFAULT 80,
    "minATSScore" INTEGER NOT NULL DEFAULT 85,
    "maxApplicationsPerDay" INTEGER NOT NULL DEFAULT 50,
    "schedule" TEXT NOT NULL DEFAULT 'ONCE',
    "customCron" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "search_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resumes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Master Resume',
    "isMaster" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT NOT NULL,
    "rawFile" BYTEA,
    "fileName" TEXT,
    "mimeType" TEXT,
    "parsedData" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_versions" (
    "id" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "jobId" TEXT,
    "company" TEXT,
    "role" TEXT,
    "jdHash" TEXT,
    "content" TEXT NOT NULL,
    "htmlContent" TEXT,
    "atsScoreOverall" DOUBLE PRECISION,
    "atsScoreData" JSONB,
    "keywordCoverage" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "changesFromMaster" JSONB NOT NULL DEFAULT '[]',
    "sourceFacts" JSONB NOT NULL DEFAULT '[]',
    "filePath" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceJobId" TEXT,
    "company" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT,
    "location" TEXT,
    "remoteType" TEXT,
    "description" TEXT NOT NULL,
    "requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "responsibilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "salaryMin" DOUBLE PRECISION,
    "salaryMax" DOUBLE PRECISION,
    "salaryCurrency" TEXT,
    "salaryPeriod" TEXT,
    "employmentType" TEXT,
    "seniority" TEXT,
    "experienceMin" INTEGER,
    "experienceMax" INTEGER,
    "postedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "applicationUrl" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "companyUrl" TEXT,
    "fingerprint" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "duplicateGroupId" TEXT,
    "duplicateCount" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_analyses" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "mustHave" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "niceToHave" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "potentiallyOptional" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "technologyStack" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "hiddenSignals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "leadershipExpected" BOOLEAN NOT NULL DEFAULT false,
    "communicationLevel" TEXT,
    "domainExperience" TEXT,
    "teamSize" TEXT,
    "methodologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "benefits" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "redFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "analyzedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_matches" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "overall" DOUBLE PRECISION NOT NULL,
    "roleMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "skillMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "experienceMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "seniorityMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "locationMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "salaryMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "technologyMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "industryMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "educationMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "certificationMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "workAuthorizationMatch" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tier" TEXT NOT NULL,
    "matchedSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingSkills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchedTechnologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "missingTechnologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "resumeVersionId" TEXT NOT NULL,
    "coverLetterId" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DISCOVERED',
    "submissionStatus" TEXT,
    "matchScore" DOUBLE PRECISION,
    "atsScore" DOUBLE PRECISION,
    "qualityScore" JSONB,
    "appliedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "confirmationId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "automationRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_attempts" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "fieldsDetected" INTEGER NOT NULL DEFAULT 0,
    "fieldsFilled" INTEGER NOT NULL DEFAULT 0,
    "screenshot" TEXT,
    "logs" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "application_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_documents" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cover_letters" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'STANDARD',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cover_letters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AutomationStatus" NOT NULL DEFAULT 'IDLE',
    "mode" "AutomationMode" NOT NULL DEFAULT 'ASSISTED',
    "activeKey" TEXT,
    "jobsScanned" INTEGER NOT NULL DEFAULT 0,
    "jobsQualified" INTEGER NOT NULL DEFAULT 0,
    "applicationsAttempted" INTEGER NOT NULL DEFAULT 0,
    "applicationsSubmitted" INTEGER NOT NULL DEFAULT 0,
    "applicationsFailed" INTEGER NOT NULL DEFAULT 0,
    "applicationsPaused" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),

    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_events" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "jobId" TEXT,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "data" JSONB,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "industry" TEXT,
    "size" TEXT,
    "location" TEXT,
    "website" TEXT,
    "careersPage" TEXT,
    "jobCount" INTEGER NOT NULL DEFAULT 0,
    "hiringActivity" TEXT,
    "technologies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_rules" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "conditions" JSONB NOT NULL DEFAULT '[]',
    "action" TEXT NOT NULL DEFAULT 'REVIEW',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "details" JSONB,
    "ipAddress" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interviews" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "type" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 1,
    "interviewer" TEXT,
    "meetingUrl" TEXT,
    "notes" TEXT,
    "preparationStatus" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offers" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "salaryOffered" DOUBLE PRECISION,
    "currency" TEXT,
    "benefits" TEXT,
    "startDate" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "automationRunId" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "lastError" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseCode" INTEGER,
    "responseBody" JSONB,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_status_transitions" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromStatus" "ApplicationStatus",
    "toStatus" "ApplicationStatus" NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT,
    "reason" TEXT NOT NULL,
    "metadata" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_status_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failure_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "applicationId" TEXT,
    "category" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "retryable" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "correlationId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "failure_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_verifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "prompt" TEXT NOT NULL,
    "context" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolution" JSONB,
    "resumeTokenHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "human_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "browser_session_references" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT,
    "workerId" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "allowedHost" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "browser_session_references_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_source_facts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resumeId" TEXT NOT NULL,
    "resumeVersionId" TEXT,
    "factType" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "sourceText" TEXT NOT NULL,
    "sourceStart" INTEGER,
    "sourceEnd" INTEGER,
    "checksum" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_source_facts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_questions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "externalKey" TEXT,
    "label" TEXT NOT NULL,
    "normalizedKey" TEXT,
    "fieldType" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "risk" TEXT NOT NULL,
    "options" JSONB,
    "source" JSONB,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_answers" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_answers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embeddings" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "vectorData" vector NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "object_metadata" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "versionId" TEXT,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "byteSize" BIGINT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "encryptionKeyRef" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "scanDetails" JSONB,
    "expiresAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "provenance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "object_metadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_userId_key" ON "user_profiles"("userId");

-- CreateIndex
CREATE INDEX "jobs_company_idx" ON "jobs"("company");

-- CreateIndex
CREATE INDEX "jobs_normalizedTitle_idx" ON "jobs"("normalizedTitle");

-- CreateIndex
CREATE INDEX "jobs_location_idx" ON "jobs"("location");

-- CreateIndex
CREATE INDEX "jobs_postedAt_idx" ON "jobs"("postedAt");

-- CreateIndex
CREATE INDEX "jobs_fingerprint_idx" ON "jobs"("fingerprint");

-- CreateIndex
CREATE INDEX "jobs_duplicateGroupId_idx" ON "jobs"("duplicateGroupId");

-- CreateIndex
CREATE INDEX "jobs_isActive_idx" ON "jobs"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_source_sourceJobId_key" ON "jobs"("source", "sourceJobId");

-- CreateIndex
CREATE UNIQUE INDEX "job_analyses_jobId_key" ON "job_analyses"("jobId");

-- CreateIndex
CREATE INDEX "job_matches_userId_overall_idx" ON "job_matches"("userId", "overall");

-- CreateIndex
CREATE UNIQUE INDEX "job_matches_jobId_userId_key" ON "job_matches"("jobId", "userId");

-- CreateIndex
CREATE INDEX "applications_status_idx" ON "applications"("status");

-- CreateIndex
CREATE INDEX "applications_userId_status_idx" ON "applications"("userId", "status");

-- CreateIndex
CREATE INDEX "applications_appliedAt_idx" ON "applications"("appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "applications_userId_jobId_key" ON "applications"("userId", "jobId");

-- CreateIndex
CREATE INDEX "application_attempts_applicationId_startedAt_idx" ON "application_attempts"("applicationId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "application_attempts_applicationId_attemptNumber_key" ON "application_attempts"("applicationId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "automation_runs_activeKey_key" ON "automation_runs"("activeKey");

-- CreateIndex
CREATE INDEX "automation_runs_userId_status_idx" ON "automation_runs"("userId", "status");

-- CreateIndex
CREATE INDEX "automation_events_runId_timestamp_idx" ON "automation_events"("runId", "timestamp");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE UNIQUE INDEX "companies_normalizedName_key" ON "companies"("normalizedName");

-- CreateIndex
CREATE INDEX "audit_logs_userId_timestamp_idx" ON "audit_logs"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_resource_action_idx" ON "audit_logs"("resource", "action");

-- CreateIndex
CREATE INDEX "offers_userId_status_idx" ON "offers"("userId", "status");

-- CreateIndex
CREATE INDEX "offers_applicationId_idx" ON "offers"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "automation_jobs_idempotencyKey_key" ON "automation_jobs"("idempotencyKey");

-- CreateIndex
CREATE INDEX "automation_jobs_status_availableAt_priority_idx" ON "automation_jobs"("status", "availableAt", "priority");

-- CreateIndex
CREATE INDEX "automation_jobs_userId_status_idx" ON "automation_jobs"("userId", "status");

-- CreateIndex
CREATE INDEX "automation_jobs_applicationId_idx" ON "automation_jobs"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_idempotencyKey_key" ON "outbox_events"("idempotencyKey");

-- CreateIndex
CREATE INDEX "outbox_events_publishedAt_availableAt_idx" ON "outbox_events"("publishedAt", "availableAt");

-- CreateIndex
CREATE INDEX "outbox_events_aggregateType_aggregateId_occurredAt_idx" ON "outbox_events"("aggregateType", "aggregateId", "occurredAt");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_key_key" ON "idempotency_records"("scope", "key");

-- CreateIndex
CREATE UNIQUE INDEX "application_status_transitions_idempotencyKey_key" ON "application_status_transitions"("idempotencyKey");

-- CreateIndex
CREATE INDEX "application_status_transitions_applicationId_createdAt_idx" ON "application_status_transitions"("applicationId", "createdAt");

-- CreateIndex
CREATE INDEX "application_status_transitions_userId_createdAt_idx" ON "application_status_transitions"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "failure_records_applicationId_occurredAt_idx" ON "failure_records"("applicationId", "occurredAt");

-- CreateIndex
CREATE INDEX "failure_records_category_occurredAt_idx" ON "failure_records"("category", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "human_verifications_resumeTokenHash_key" ON "human_verifications"("resumeTokenHash");

-- CreateIndex
CREATE INDEX "human_verifications_userId_status_expiresAt_idx" ON "human_verifications"("userId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "human_verifications_applicationId_status_idx" ON "human_verifications"("applicationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "browser_session_references_externalRef_key" ON "browser_session_references"("externalRef");

-- CreateIndex
CREATE INDEX "browser_session_references_userId_status_idx" ON "browser_session_references"("userId", "status");

-- CreateIndex
CREATE INDEX "browser_session_references_expiresAt_idx" ON "browser_session_references"("expiresAt");

-- CreateIndex
CREATE INDEX "resume_source_facts_userId_approved_factType_idx" ON "resume_source_facts"("userId", "approved", "factType");

-- CreateIndex
CREATE UNIQUE INDEX "resume_source_facts_resumeId_checksum_key" ON "resume_source_facts"("resumeId", "checksum");

-- CreateIndex
CREATE INDEX "application_questions_applicationId_orderIndex_idx" ON "application_questions"("applicationId", "orderIndex");

-- CreateIndex
CREATE INDEX "application_questions_userId_risk_idx" ON "application_questions"("userId", "risk");

-- CreateIndex
CREATE UNIQUE INDEX "application_questions_applicationId_externalKey_key" ON "application_questions"("applicationId", "externalKey");

-- CreateIndex
CREATE INDEX "application_answers_applicationId_approved_idx" ON "application_answers"("applicationId", "approved");

-- CreateIndex
CREATE INDEX "application_answers_userId_createdAt_idx" ON "application_answers"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "application_answers_questionId_key" ON "application_answers"("questionId");

-- CreateIndex
CREATE INDEX "embeddings_userId_entityType_idx" ON "embeddings"("userId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "embeddings_entityType_entityId_model_contentHash_key" ON "embeddings"("entityType", "entityId", "model", "contentHash");

-- CreateIndex
CREATE INDEX "object_metadata_userId_kind_createdAt_idx" ON "object_metadata"("userId", "kind", "createdAt");

-- CreateIndex
CREATE INDEX "object_metadata_expiresAt_deletedAt_idx" ON "object_metadata"("expiresAt", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "object_metadata_bucket_objectKey_versionId_key" ON "object_metadata"("bucket", "objectKey", "versionId");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_analyses" ADD CONSTRAINT "job_analyses_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_resumeVersionId_fkey" FOREIGN KEY ("resumeVersionId") REFERENCES "resume_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_coverLetterId_fkey" FOREIGN KEY ("coverLetterId") REFERENCES "cover_letters"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_automationRunId_fkey" FOREIGN KEY ("automationRunId") REFERENCES "automation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_documents" ADD CONSTRAINT "application_documents_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_letters" ADD CONSTRAINT "cover_letters_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cover_letters" ADD CONSTRAINT "cover_letters_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_events" ADD CONSTRAINT "automation_events_runId_fkey" FOREIGN KEY ("runId") REFERENCES "automation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_rules" ADD CONSTRAINT "user_rules_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_automationRunId_fkey" FOREIGN KEY ("automationRunId") REFERENCES "automation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_status_transitions" ADD CONSTRAINT "application_status_transitions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_status_transitions" ADD CONSTRAINT "application_status_transitions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_records" ADD CONSTRAINT "failure_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failure_records" ADD CONSTRAINT "failure_records_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_verifications" ADD CONSTRAINT "human_verifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_verifications" ADD CONSTRAINT "human_verifications_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_session_references" ADD CONSTRAINT "browser_session_references_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "browser_session_references" ADD CONSTRAINT "browser_session_references_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_source_facts" ADD CONSTRAINT "resume_source_facts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_source_facts" ADD CONSTRAINT "resume_source_facts_resumeId_fkey" FOREIGN KEY ("resumeId") REFERENCES "resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_source_facts" ADD CONSTRAINT "resume_source_facts_resumeVersionId_fkey" FOREIGN KEY ("resumeVersionId") REFERENCES "resume_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "application_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "object_metadata" ADD CONSTRAINT "object_metadata_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Foundation invariants Prisma cannot express
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_version_positive" CHECK ("version" > 0);
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_experience_nonnegative" CHECK ("yearsOfExperience" >= 0);
ALTER TABLE "resumes" ADD CONSTRAINT "resumes_version_positive" CHECK ("version" > 0);
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_ats_score_range" CHECK ("atsScoreOverall" IS NULL OR "atsScoreOverall" BETWEEN 0 AND 100);
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_keyword_coverage_range" CHECK ("keywordCoverage" BETWEEN 0 AND 100);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_version_positive" CHECK ("version" > 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_duplicate_count_positive" CHECK ("duplicateCount" > 0);
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_experience_range" CHECK ("experienceMin" IS NULL OR "experienceMax" IS NULL OR "experienceMin" <= "experienceMax");
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_salary_range" CHECK ("salaryMin" IS NULL OR "salaryMax" IS NULL OR "salaryMin" <= "salaryMax");
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_match_score_range" CHECK ("minMatchScore" BETWEEN 0 AND 100);
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_ats_score_range" CHECK ("minATSScore" BETWEEN 0 AND 100);
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_daily_limit_positive" CHECK ("maxApplicationsPerDay" > 0);
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_experience_range" CHECK ("experienceMin" IS NULL OR "experienceMax" IS NULL OR "experienceMin" <= "experienceMax");
ALTER TABLE "search_profiles" ADD CONSTRAINT "search_profiles_salary_range" CHECK ("salaryMin" IS NULL OR "salaryMax" IS NULL OR "salaryMin" <= "salaryMax");
ALTER TABLE "job_matches" ADD CONSTRAINT "job_matches_scores_range" CHECK (
  "overall" BETWEEN 0 AND 100 AND "roleMatch" BETWEEN 0 AND 100 AND "skillMatch" BETWEEN 0 AND 100
  AND "experienceMatch" BETWEEN 0 AND 100 AND "seniorityMatch" BETWEEN 0 AND 100
  AND "locationMatch" BETWEEN 0 AND 100 AND "salaryMatch" BETWEEN 0 AND 100
  AND "technologyMatch" BETWEEN 0 AND 100 AND "industryMatch" BETWEEN 0 AND 100
  AND "educationMatch" BETWEEN 0 AND 100 AND "certificationMatch" BETWEEN 0 AND 100
  AND "workAuthorizationMatch" BETWEEN 0 AND 100
);
ALTER TABLE "applications" ADD CONSTRAINT "applications_version_positive" CHECK ("version" > 0);
ALTER TABLE "applications" ADD CONSTRAINT "applications_score_range" CHECK (("matchScore" IS NULL OR "matchScore" BETWEEN 0 AND 100) AND ("atsScore" IS NULL OR "atsScore" BETWEEN 0 AND 100));
ALTER TABLE "applications" ADD CONSTRAINT "applications_retry_bounds" CHECK ("retryCount" >= 0 AND "maxRetries" >= 0 AND "retryCount" <= "maxRetries");
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_number_positive" CHECK ("attemptNumber" > 0);
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_fields_nonnegative" CHECK ("fieldsDetected" >= 0 AND "fieldsFilled" >= 0 AND "fieldsFilled" <= "fieldsDetected");
ALTER TABLE "application_attempts" ADD CONSTRAINT "application_attempts_time_order" CHECK ("completedAt" IS NULL OR "completedAt" >= "startedAt");
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_counts_nonnegative" CHECK (
  "jobsScanned" >= 0 AND "jobsQualified" >= 0 AND "applicationsAttempted" >= 0
  AND "applicationsSubmitted" >= 0 AND "applicationsFailed" >= 0 AND "applicationsPaused" >= 0
);
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_attempt_bounds" CHECK ("attemptCount" >= 0 AND "maxAttempts" > 0 AND "attemptCount" <= "maxAttempts");
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_payload_version_positive" CHECK ("payloadVersion" > 0);
ALTER TABLE "automation_jobs" ADD CONSTRAINT "automation_jobs_lease_consistency" CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL) AND ("status" <> 'LEASED' OR "leaseOwner" IS NOT NULL));
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_schema_version_positive" CHECK ("schemaVersion" > 0);
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_publish_attempts_nonnegative" CHECK ("publishAttempts" >= 0);
ALTER TABLE "application_status_transitions" ADD CONSTRAINT "application_status_transitions_version_positive" CHECK ("version" > 0);
ALTER TABLE "failure_records" ADD CONSTRAINT "failure_records_resolution_order" CHECK ("resolvedAt" IS NULL OR "resolvedAt" >= "occurredAt");
ALTER TABLE "human_verifications" ADD CONSTRAINT "human_verifications_expiry_order" CHECK ("expiresAt" > "createdAt" AND ("resolvedAt" IS NULL OR "resolvedAt" >= "createdAt"));
ALTER TABLE "browser_session_references" ADD CONSTRAINT "browser_sessions_time_order" CHECK ("expiresAt" > "createdAt" AND ("lastHeartbeatAt" IS NULL OR "lastHeartbeatAt" >= "createdAt") AND ("closedAt" IS NULL OR "closedAt" >= "createdAt"));
ALTER TABLE "resume_source_facts" ADD CONSTRAINT "resume_source_facts_source_range" CHECK (("sourceStart" IS NULL) = ("sourceEnd" IS NULL) AND ("sourceStart" IS NULL OR ("sourceStart" >= 0 AND "sourceEnd" >= "sourceStart")));
ALTER TABLE "resume_source_facts" ADD CONSTRAINT "resume_source_facts_approval_consistency" CHECK (("approvedAt" IS NULL AND "approvedBy" IS NULL) OR ("approved" = true AND "approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL));
ALTER TABLE "application_questions" ADD CONSTRAINT "application_questions_order_nonnegative" CHECK ("orderIndex" >= 0);
ALTER TABLE "application_answers" ADD CONSTRAINT "application_answers_approval_consistency" CHECK ("approvedAt" IS NULL OR ("approved" = true AND "approvedAt" >= "createdAt"));
ALTER TABLE "object_metadata" ADD CONSTRAINT "object_metadata_byte_size_nonnegative" CHECK ("byteSize" >= 0);
ALTER TABLE "object_metadata" ADD CONSTRAINT "object_metadata_deletion_consistency" CHECK ("deletedAt" IS NULL OR "deletedAt" >= "createdAt");
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_dimensions_positive" CHECK ("dimensions" > 0);
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_round_positive" CHECK ("round" > 0);

CREATE UNIQUE INDEX "resumes_one_master_per_user" ON "resumes"("userId") WHERE "isMaster" = true;
CREATE UNIQUE INDEX "jobs_source_fingerprint_key" ON "jobs"("source", "fingerprint") WHERE "sourceJobId" IS NULL AND "fingerprint" IS NOT NULL;
CREATE INDEX "applications_user_created_idx" ON "applications"("userId", "createdAt");
CREATE INDEX "notifications_user_created_idx" ON "notifications"("userId", "createdAt");
CREATE INDEX "automation_jobs_lease_expiry_idx" ON "automation_jobs"("leaseExpiresAt") WHERE "status" = 'LEASED';
CREATE INDEX "outbox_events_unpublished_idx" ON "outbox_events"("availableAt", "occurredAt") WHERE "publishedAt" IS NULL;

-- Tenant context helpers and row-level security
CREATE SCHEMA IF NOT EXISTS app;
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS text
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT NULLIF(current_setting('app.current_user_id', true), '') $$;

CREATE OR REPLACE FUNCTION app.is_service() RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE
AS $$ SELECT pg_has_role(current_user, 'jobagent_service', 'MEMBER') $$;

CREATE OR REPLACE FUNCTION app.owns_application(target_application_id text, tenant_user_id text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM applications WHERE id = target_application_id AND "userId" = tenant_user_id) $$;

CREATE OR REPLACE FUNCTION app.owns_resume(target_resume_id text, tenant_user_id text) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM resumes WHERE id = target_resume_id AND "userId" = tenant_user_id) $$;

CREATE OR REPLACE FUNCTION app.require_owner_consistency() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW."applicationId" IS NOT NULL AND NOT app.owns_application(NEW."applicationId", NEW."userId") THEN
    RAISE EXCEPTION 'application owner does not match userId' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER automation_jobs_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "automation_jobs" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER application_status_transitions_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "application_status_transitions" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER failure_records_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "failure_records" FOR EACH ROW WHEN (NEW."userId" IS NOT NULL) EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER human_verifications_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "human_verifications" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER browser_sessions_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "browser_session_references" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER application_questions_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "application_questions" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();
CREATE TRIGGER application_answers_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId" ON "application_answers" FOR EACH ROW EXECUTE FUNCTION app.require_owner_consistency();

CREATE OR REPLACE FUNCTION app.require_resume_fact_consistency() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.owns_resume(NEW."resumeId", NEW."userId") THEN
    RAISE EXCEPTION 'resume owner does not match userId' USING ERRCODE = '23514';
  END IF;
  IF NEW."resumeVersionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM resume_versions WHERE id = NEW."resumeVersionId" AND "resumeId" = NEW."resumeId"
  ) THEN
    RAISE EXCEPTION 'resume version does not belong to resume' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER resume_facts_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "resumeId", "resumeVersionId" ON "resume_source_facts" FOR EACH ROW EXECUTE FUNCTION app.require_resume_fact_consistency();

CREATE OR REPLACE FUNCTION app.require_answer_consistency() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.owns_application(NEW."applicationId", NEW."userId") THEN
    RAISE EXCEPTION 'application owner does not match userId' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM application_questions
    WHERE id = NEW."questionId" AND "applicationId" = NEW."applicationId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'question does not belong to application and user' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER application_answers_owner_consistency ON "application_answers";
CREATE TRIGGER application_answers_owner_consistency BEFORE INSERT OR UPDATE OF "userId", "applicationId", "questionId" ON "application_answers" FOR EACH ROW EXECUTE FUNCTION app.require_answer_consistency();

CREATE OR REPLACE FUNCTION app.require_application_artifact_consistency() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM resume_versions rv JOIN resumes r ON r.id = rv."resumeId"
    WHERE rv.id = NEW."resumeVersionId" AND r."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'resume version owner does not match application userId' USING ERRCODE = '23514';
  END IF;
  IF NEW."coverLetterId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cover_letters c WHERE c.id = NEW."coverLetterId" AND c."userId" = NEW."userId" AND c."jobId" = NEW."jobId"
  ) THEN
    RAISE EXCEPTION 'cover letter owner or job does not match application' USING ERRCODE = '23514';
  END IF;
  IF NEW."automationRunId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM automation_runs ar WHERE ar.id = NEW."automationRunId" AND ar."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'automation run owner does not match application userId' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER applications_artifact_consistency BEFORE INSERT OR UPDATE OF "userId", "jobId", "resumeVersionId", "coverLetterId", "automationRunId" ON "applications" FOR EACH ROW EXECUTE FUNCTION app.require_application_artifact_consistency();

-- Public jobs and company metadata are shared; every table below contains user-owned data directly or through an owner.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "search_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resumes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cover_letters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interviews" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "offers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "automation_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_status_transitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "failure_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "human_verifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "browser_session_references" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_source_facts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "object_metadata" ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_tenant_isolation ON "users" USING (id = app.current_user_id()) WITH CHECK (id = app.current_user_id());
CREATE POLICY user_profiles_tenant_isolation ON "user_profiles" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY search_profiles_tenant_isolation ON "search_profiles" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY resumes_tenant_isolation ON "resumes" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY resume_versions_tenant_isolation ON "resume_versions" USING (app.owns_resume("resumeId", app.current_user_id())) WITH CHECK (app.owns_resume("resumeId", app.current_user_id()));
CREATE POLICY job_matches_tenant_isolation ON "job_matches" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY applications_tenant_isolation ON "applications" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY application_attempts_tenant_isolation ON "application_attempts" USING (app.owns_application("applicationId", app.current_user_id())) WITH CHECK (app.owns_application("applicationId", app.current_user_id()));
CREATE POLICY application_documents_tenant_isolation ON "application_documents" USING (app.owns_application("applicationId", app.current_user_id())) WITH CHECK (app.owns_application("applicationId", app.current_user_id()));
CREATE POLICY cover_letters_tenant_isolation ON "cover_letters" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY automation_runs_tenant_isolation ON "automation_runs" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY automation_events_tenant_isolation ON "automation_events" USING (EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.id = "runId" AND ar."userId" = app.current_user_id())) WITH CHECK (EXISTS (SELECT 1 FROM automation_runs ar WHERE ar.id = "runId" AND ar."userId" = app.current_user_id()));
CREATE POLICY notifications_tenant_isolation ON "notifications" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY user_rules_tenant_isolation ON "user_rules" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY audit_logs_tenant_isolation ON "audit_logs" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY interviews_tenant_isolation ON "interviews" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY offers_tenant_isolation ON "offers" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY automation_jobs_tenant_isolation ON "automation_jobs" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY outbox_events_tenant_isolation ON "outbox_events" USING ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service())) WITH CHECK ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service()));
CREATE POLICY idempotency_records_tenant_isolation ON "idempotency_records" USING ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service())) WITH CHECK ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service()));
CREATE POLICY application_status_transitions_tenant_isolation ON "application_status_transitions" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY failure_records_tenant_isolation ON "failure_records" USING ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service())) WITH CHECK ("userId" = app.current_user_id() OR ("userId" IS NULL AND app.is_service()));
CREATE POLICY human_verifications_tenant_isolation ON "human_verifications" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY browser_session_references_tenant_isolation ON "browser_session_references" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY resume_source_facts_tenant_isolation ON "resume_source_facts" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY application_questions_tenant_isolation ON "application_questions" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY application_answers_tenant_isolation ON "application_answers" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY embeddings_tenant_isolation ON "embeddings" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());
CREATE POLICY object_metadata_tenant_isolation ON "object_metadata" USING ("userId" = app.current_user_id()) WITH CHECK ("userId" = app.current_user_id());

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobagent_service') THEN
    CREATE ROLE jobagent_service NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jobagent_app') THEN
    CREATE ROLE jobagent_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA public, app TO jobagent_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO jobagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jobagent_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO jobagent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jobagent_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO jobagent_app;

COMMENT ON FUNCTION app.current_user_id() IS 'Returns the transaction-local tenant set with SET LOCAL app.current_user_id.';
COMMENT ON FUNCTION app.is_service() IS 'Returns true only for database roles granted membership in jobagent_service.';
