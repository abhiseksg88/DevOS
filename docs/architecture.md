# NimbusForge — AI-Native Cloud Application Builder

## Architecture Overview

```
                        +--------------------------+
                        |    NimbusForge Frontend   |
                        |  Next.js + Supabase Auth  |
                        |  (Google/GitHub OAuth)    |
                        +-------------|------------+
                                      | REST + Realtime (SSE/WS)
                                      v
                   +------------------+------------------+
                   |         Supabase Platform           |
                   |  +--------+ +-------+ +---------+  |
                   |  |Postgres| | Auth  | |Realtime |  |
                   |  | + RLS  | | OAuth | |  PubSub |  |
                   |  +--------+ +-------+ +---------+  |
                   |  +--------+ +---------+             |
                   |  |Storage | | Edge Fn |             |
                   |  |(assets)| |(webhooks)|            |
                   |  +--------+ +---------+             |
                   +------------------+------------------+
                                      |
                   service-role JWT    | (privileged writes)
                                      v
              +---------------------------------------------------+
              |            FastAPI Control Plane                   |
              |                                                   |
              |  /tenants  /projects  /builds  /deployments       |
              |  /build-events (SSE stream)                       |
              |                                                   |
              |  +--------------------------------------------+   |
              |  |        LangGraph Agent Orchestrator         |  |
              |  |                                             |  |
              |  |  +-----------+  +----------+  +----------+ |  |
              |  |  | Planner   |  | Coder    |  | Reviewer | |  |
              |  |  | (Opus)    |  | (Sonnet) |  | (Haiku)  | |  |
              |  |  +-----------+  +----------+  +----------+ |  |
              |  |  +-----------+  +----------+               |  |
              |  |  |Scaffolder |  | Deployer |               |  |
              |  |  |(DeepSeek) |  | (infra)  |               |  |
              |  |  +-----------+  +----------+               |  |
              |  +--------------------------------------------+   |
              +----------------------|----------------------------+
                                     |
                    +----------------+----------------+
                    |                                  |
                    v                                  v
          +-----------------+              +--------------------+
          | Docker Build    |              | Container Registry |
          | (kaniko/buildx) |              | (GCR / Fly.io)     |
          +-----------------+              +--------------------+
                    |                                  |
                    v                                  v
          +-----------------+              +--------------------+
          | Cloud Run /     |              | Preview Router     |
          | Fly.io Deploy   |              | (Caddy/Traefik)    |
          +-----------------+              +--------------------+
                    |
                    v
          +----------------------------+
          | Preview URLs               |
          | {build_id}.preview.nimbus  |
          | forge.dev                  |
          +----------------------------+
```

## Component Responsibilities

### 1. Frontend (Next.js)

- **Authentication**: Supabase Auth with Google and GitHub OAuth providers.
  User sessions are JWT-based, with Supabase handling refresh tokens.
- **Project Dashboard**: CRUD for tenants, projects, environments.
  Real-time build status via Supabase Realtime subscriptions on `build_events`.
- **Code Editor**: Monaco-based editor with AI prompt bar. User describes intent;
  frontend sends to `/builds` endpoint. Shows streaming diff patches in real-time.
- **Preview Panel**: Embedded iframe showing the live preview URL for the latest deploy.
- **Billing/Usage**: Shows token consumption, build minutes, storage usage per tenant.

### 2. Supabase Platform

- **Postgres + RLS**: All data lives here. Every table has `tenant_id` column with
  Row Level Security policies. No data leaks between tenants. Period.
- **Auth**: Issues JWTs with `tenant_id` and `role` in claims. Backend validates
  these on every request.
- **Realtime**: `build_events` table changes broadcast to subscribed frontends.
  This is how the UI shows live build logs, agent reasoning, and deploy status.
- **Storage**: Project source archives, generated assets, build artifacts.
  Bucket paths: `{tenant_id}/{project_id}/...`. RLS on storage too.
- **Edge Functions**: Lightweight webhooks (GitHub push triggers, deploy callbacks).

### 3. FastAPI Control Plane

- **REST API**: Standard CRUD for tenants, projects, builds, deployments.
  All endpoints validate Supabase JWT. Uses service-role key for writes
  (inserts into build_events, deployments, etc.).
- **SSE Streaming**: `/builds/{build_id}/events` streams build_events in real-time
  as Server-Sent Events. Frontend subscribes here during active builds.
- **Rate Limiting**: Token bucket per tenant. Configurable per plan tier.
- **Request Routing**: Validates tenant quotas, checks budget, then dispatches
  to the agent orchestrator.

### 4. LangGraph Agent Orchestrator

Five specialized agents in a directed graph:

| Agent      | Model     | Role                                    | Input                    | Output                      |
|------------|-----------|----------------------------------------|--------------------------|-----------------------------|
| Planner    | Opus      | Architecture decisions, task breakdown  | User prompt + memory     | Plan JSON (cached 1h)       |
| Scaffolder | DeepSeek  | Bulk file generation, boilerplate      | Plan + template specs    | File tree + base content    |
| Coder      | Sonnet    | Code edits, refactors, bug fixes       | Plan + existing files    | Unified diff patches        |
| Reviewer   | Haiku     | QA, security audit, test generation    | Patches + full context   | Approve/reject + findings   |
| Deployer   | Internal  | Build + deploy orchestration           | Approved code            | Deploy status + preview URL |

**Graph flow**: Planner -> Scaffolder (if new project) -> Coder -> Reviewer -> (loop if rejected) -> Deployer

### 5. Build/Deploy Pipeline

- **Dockerfile Generation**: Agent generates optimized, multi-stage Dockerfiles
  based on detected stack (Node, Python, Go, etc.).
- **Image Build**: kaniko (in Cloud Run Jobs) or Docker buildx. No Docker daemon needed.
- **Registry**: Google Container Registry (GCR) or Fly.io internal registry.
- **Deploy**: `gcloud run deploy` or `fly deploy`. Zero-downtime with traffic splitting.
- **Rollback**: Previous image tag is always preserved. One-command rollback.

### 6. Preview Router

- **Strategy**: Subdomain routing: `{build_id}.preview.nimbusforge.dev`
- **SSL**: Wildcard cert via Let's Encrypt + Caddy automatic HTTPS.
- **Cleanup**: Cron job marks previews stale after 72h. Deletes after 7 days.
  Active previews (with recent HTTP traffic) are exempted from cleanup.

### 7. Cost Control

- **Budget Enforcement**: Per-tenant monthly token budget. Checked before every
  agent call. Hard stop at 100% budget; warning at 80%.
- **Rate Limiting**: Sliding window rate limiter. 10 builds/min for free tier,
  100 for pro, unlimited for enterprise (still rate-limited at 500/min).
- **Abuse Detection**: Anomaly detection on token velocity. Auto-suspend accounts
  that exceed 10x normal usage in 1-hour window.
- **Audit Log**: Every API call, agent invocation, and deploy logged with
  tenant_id, user_id, model, tokens_in, tokens_out, latency_ms, cost_usd.

## Design Principles

1. **Patch-only**: We never regenerate files. Every code change is a unified diff.
   This means we can always `git apply` and always have a clean history.

2. **Git-native**: Every change is a commit. Metadata (model, tokens, files changed,
   test results, build_id) is in the commit message as structured JSON.

3. **Memory-first**: The system maintains `architecture.md`, `api_contracts.md`,
   `design_system.json`, and `project_manifest.json` in every project repo.
   These are the "hard memory" that agents use for context. They are stored in
   Supabase Storage AND committed to the project git repo.

4. **Multi-tenant by default**: tenant_id is on every row. RLS is on every table.
   There is no "admin mode" that bypasses RLS — only service-role for backend writes.

5. **Cost-aware**: Every LLM call is logged with input/output tokens and cost.
   Budgets are enforced pre-call. The cheapest capable model is always chosen.

## Failure Scenarios & Recovery

| Failure                    | Detection              | Recovery                                    |
|----------------------------|------------------------|---------------------------------------------|
| Build timeout (>10min)     | Background task timer  | Kill build, mark FAILED, notify user        |
| Agent loop (>5 iterations) | Iteration counter      | Break loop, return best-effort, flag review |
| Deploy crash               | Health check failure   | Auto-rollback to previous revision          |
| Supabase down              | Health check + circuit | Queue writes in Redis, replay on recovery   |
| LLM provider down          | HTTP 5xx + timeout     | Fallback: Opus->Sonnet, Sonnet->DeepSeek    |
| Preview orphaned           | No HTTP traffic 72h    | Cron cleanup, delete Cloud Run revision     |
| Budget exceeded            | Pre-call check         | Block build, notify owner, suggest upgrade  |
| Git conflict               | git-apply failure      | Re-generate patch with full file context    |
