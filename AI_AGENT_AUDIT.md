# AI Agent Audit

## Verdict

Specialized agent classes exist, but none is connected to a production API/worker flow. Generic chat is the only production AI call. `completeJSON<T>` validates JSON syntax only; the TypeScript generic is not runtime validation. **AI/Agent completion: 28%. Functional autonomous-agent completion: approximately 10%.**

## Agent Matrix

| Expected agent | Exists | Provider/model | Tools / prompts | Output validation | Persistence/retry | Production call | Tests | Status |
|---|---|---|---|---|---|---|---|---|
| SupervisorAgent | Yes | Shared OpenAI-compatible provider | Sequential direct method calls | None beyond parsed JSON | None | No | No | 🟠 Backend scaffolding |
| JobDiscoveryAgent | No | — | DiscoveryEngine is non-AI utility | — | API persists jobs | Manual API only | No | 🔴 Missing agent |
| JobAnalysisAgent | Yes | OpenAI-compatible; default `gpt-4o` | JD analysis prompt | Syntax only | No retries; no production persistence | No | No | 🟠 Backend only |
| MatchingAgent | Yes | Same | Weighted scoring prompt | No range/total/tier validation | None | No | No | 🟠 Backend only |
| ResumeAgent | Yes | Same | Truthfulness/tailoring prompt | Model self-attests provenance | None | No | No | 🟠 Backend only |
| ATSAgent | Yes | Same | ATS scoring prompt | No deterministic recomputation | None | No | No | 🟠 Backend only |
| CoverLetterAgent | Yes | Same | Generation prompt | Syntax only | None | No | No | 🟠 Backend only |
| QuestionAgent | Yes | Same + regex/direct lookup | Risk patterns and prompt | Partial classification logic | None | No form integration | No | 🟠 Backend only |
| ApplicationAgent | No | — | — | — | — | — | — | 🔴 Missing |
| VerificationAgent | No | — | — | — | — | — | — | 🔴 Missing |
| AnalyticsAgent | No | — | — | — | — | — | — | 🔴 Missing |
| Generic chat assistant | Yes | Same | System prompt + messages | Plain text only | No retry/history | Yes, `/ai/chat` | No | 🧪 Implemented untested |

## Supervisor Pipeline

`SupervisorAgent.runPipeline()` sequentially performs analysis → matching → tailoring → ATS → one optional re-tailoring attempt → optional cover letter. It returns an in-memory result. It does not load user/job/resume data from Prisma, persist outputs, reserve an application, enqueue a browser job, emit events, or update the UI. Repository search found no production caller. It is therefore a library prototype, not orchestration.

## Job Analysis

The prompt requests summary, must-have/nice-to-have requirements, technologies, hidden signals, leadership, communication, domain, methodologies, benefits, and red flags. Missing production requirements: model/provider identifier, prompt version/hash, input hash, output schema version, confidence, citations to JD spans, runtime schema validation, hostile-instruction filtering, retry/backoff, and persistence invocation.

## Matching

Prompt weights role 20%, skills 20%, experience 15%, technology 15%, seniority 10%, location 10%, salary 5%, education/certification 5%. The model supplies component and overall scores. Code does not recompute the weighted total, constrain 0–100 ranges, verify tier consistency, distinguish missing data from mismatch, use authorization/industry robustly, track profile/resume basis, or implement embeddings/semantic retrieval. Match score controls only the disconnected SupervisorAgent branch, not production qualification.

## Resume Tailoring

| Required step | Status | Finding |
|---|---|---|
| Read JD / extract requirements | 🟡 | Receives job/analysis in disconnected pipeline. |
| Compare candidate profile | 🟡 | Prompt receives profile data; no production data loader. |
| Select experience/projects/skills | 🧪 | Requested from model; no independent selection verifier. |
| Job-specific summary/rewrite/reorder | 🧪 | Model can return content and change lists. |
| Preserve truthfulness | ⚠️ | Prompt instruction only; model itself marks facts `verified`. |
| Track source facts | ⚠️ | JSON field exists, but no source record/citation verifier. |
| Unique resume | 🧪 | In-memory output only. |
| Save ResumeVersion / associate Job | 🔴 | No production persistence. |
| Associate Application | 🔴 | No application creation. |
| Generate PDF/DOCX | 🔴 | No binary renderer. |

## ATS Engine

The ATS agent asks the LLM to assess keyword alignment, skills, title, experience, formatting, section detection, parsing safety, achievements, and readability. It is not a deterministic ATS engine. There is no measurable tokenizer/coverage calculation, required-vs-preferred skill matcher, contact/date/section parser, formatting-risk scanner, unsupported-claim check, keyword-stuffing detector, stable model/prompt version, reproducibility contract, or score recomputation. The score does not gate production submission and is not persisted by a production route.

## Question Agent

High-risk patterns and direct profile lookups are useful scaffolding. Unknown questions may be sent to the LLM, and SupervisorAgent falls back to human review on errors. Missing: browser extraction, normalized ApplicationQuestion/Answer, confidence calibration, exact source citation, runtime schemas, sensitive-category policy, user approval API/UI, replay, answer versioning, and prohibition enforcement against invented facts. It cannot currently answer an application form.

## Tool/Function Matrix

| Function | Exists | Implemented | Called in production | Tested | E2E |
|---|---:|---:|---:|---:|---:|
| `searchJobs()` | Equivalent adapter methods | Yes | Yes via discover API | No | No |
| `getJob()` | Adapter/API variants | Yes | API detail uses DB, adapter method not central | No | No |
| `analyzeJob()` | Agent method | Yes | No | No | No |
| `calculateMatch()` | Agent method | Yes | No | No | No |
| `generateResume()` | Tailoring/generator methods | Partial | No | No | No |
| `runATSScan()` | Agent method | Partial | No | No | No |
| `generateCoverLetter()` | Agent method | Partial | No | No | No |
| `createApplication()` | No service/API | No | No | No | No |
| `openApplication()` | No | No | No | No | No |
| `detectForm()` | No | No | No | No | No |
| `mapFields()` | No | No | No | No | No |
| `fillApplication()` | No | No | No | No | No |
| `uploadResume()` | UI/API master upload only | Partial | Yes for master resume | No | No |
| `answerQuestion()` | Agent method | Partial | No | No | No |
| `requestHumanVerification()` | No | No | No | No | No |
| `submitApplication()` | No | No | No | No | No |
| `verifySubmission()` | No | No | No | No | No |
| `updateApplicationStatus()` | PATCH route | Unsafe partial | Frontend does not call | No | No |
| `pause/resume/stopAutomation()` | API routes | Record mutation only | Pause/start UI; stop absent | No | No |
| `getAnalytics()` | API queries | Partial | Yes | No | No |

## AI Security

| Threat | Current control | Gap / required control |
|---|---|---|
| JD prompt injection | System prompt only | Treat JD as quoted data; extraction schema; instruction classifier; adversarial tests. |
| Hostile webpage/HTML | Browser absent | Future browser must sanitize extraction and never pass page instructions as tool policy. |
| Invalid model JSON | Parse + max length | Runtime schemas, enum/range/cross-field validation, bounded repair/retry. |
| Hallucinated resume facts | Prompt warning | Deterministic source-fact resolver and rejection of uncited claims. |
| Tool overreach | No AI tools currently | Capability-scoped tools, allowlisted arguments, approvals, audit logs, least privilege. |
| Arbitrary navigation | Browser absent | Host allowlists, redirect checks, private-network denial, download/file controls. |
| Secret/PII leakage | General system prompt | Field minimization, redaction, provider retention policy, per-field classification. |
| Model drift | Environment model only | Persist model/prompt/schema/input versions and run offline evaluations. |

## Required AI Production Contract

1. Zod/JSON Schema validation for every model output and deterministic cross-field checks.
2. Versioned prompt/model/provider/input/output metadata with content hashes.
3. Job descriptions and webpage text treated only as untrusted data.
4. Deterministic eligibility, match aggregation, ATS signals, and claim verification around LLM suggestions.
5. Bounded retry/backoff/timeouts/circuit breakers and classified failures.
6. Durable, idempotent queued execution with cost/token/latency telemetry.
7. Evaluation sets for extraction accuracy, score stability, resume truthfulness, and prompt injection.
8. Human approval for ambiguous/sensitive/high-risk answers and irreversible submission policy.

## Conclusion

The codebase contains promising prompt prototypes, not deployed autonomous agents. Until the agents are validated, persisted, queued, tested, and connected to application execution, AI should be described as a generic assistant plus disconnected backend experiments.
