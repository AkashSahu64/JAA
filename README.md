# Job Application Agent

A full-stack TypeScript workspace for discovering jobs, scoring fit, tailoring resumes, tracking applications, and supervising assisted automation.

## Prerequisites

- Node.js 20+
- npm 10+
- PostgreSQL 15+
- An OpenAI-compatible API key for AI features (optional if the AI assistant is not used)

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Copy `.env.example` to `.env` and fill every required value. Generate independent security secrets, for example:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

3. Start PostgreSQL. With Docker Desktop installed, the included development database is:

   ```powershell
   docker compose up -d postgres
   ```

   Alternatively, create the database in an existing PostgreSQL 15+ server and update `DATABASE_URL`.

4. Generate the Prisma client and synchronize the schema:

   ```powershell
   npm run db:generate
   npm run db:push
   ```

5. Start the API and web app:

   ```powershell
   npm run dev
   ```

6. Open `http://localhost:5173`. Register an account with a password of at least 12 characters. The API health endpoint is `http://localhost:3001/api/health`.

The web interface now uses authenticated API data for jobs, applications, resumes, analytics, rules, automation status/events, and AI chat. The Jobs page can import public Greenhouse and Lever listings when you provide board/company slugs you are authorized to query. Employer-form browser automation is intentionally not represented as active: the current backend does not include a Playwright submission worker.

## Validation

Run the complete local validation pipeline:

```powershell
npm run check
```

This generates Prisma types, type-checks the workspace, lints sources, runs tests, and creates production builds.

## Workspace layout

- `apps/api` — Express API, authentication, job/application/resume/automation endpoints
- `apps/web` — React and Vite dashboard
- `packages/ai` — AI provider and specialist agents
- `packages/database` — Prisma schema and database client
- `packages/job-engine` — discovery adapters, normalization, deduplication, and rules
- `packages/resume-engine` — parsing, generation, and resume version management
- `packages/security` — authentication, encryption, credential storage, and sanitization
- `packages/types` — shared domain contracts

## Operational notes

- Keep `.env`, uploaded files, and logs out of version control.
- Use assisted automation and review generated answers before submission, especially legal, demographic, salary, authorization, and disclosure questions.
- Job-board integrations must comply with each source's terms, robots policy, and rate limits.
- Production deployments should terminate TLS at a trusted proxy, use a restricted database role, rotate secrets, and persist uploaded documents in encrypted private storage.
