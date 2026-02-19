# Critical Architectural Disconnects (Codebase Analysis)

This report identifies **critical architecture-level disconnects** between the stated platform design and the currently implemented system.

## 1) Two Competing Control Planes for Core AI Generation

### What the architecture says
- The frontend should call a centralized FastAPI control plane for build/generation workflows.

### What the code does
- A complete AI generation pipeline runs inside Next.js API routes (`/api/generate`, `/api/swarm/analyze`, `/api/swarm/review`) and calls model providers directly.
- In parallel, the Python backend also exposes build/orchestration endpoints and its own multi-agent pipeline.

### Why this is critical
- You now have two “sources of truth” for orchestration logic, model prompts, safety/review behavior, and cost/rate governance.
- This creates drift risk, inconsistent output quality, and duplicated operational debugging.

### Evidence
- Next generation path in frontend hooks/routes: `useGenerate` -> `/api/generate` + `/api/swarm/*`.
- Backend build/orchestrator path: FastAPI `/tenants/{tenant}/projects/{project}/builds` and `nimbusforge.agents.orchestrator`.

---

## 2) Data Access Layer Split (Backend API vs Direct Browser-to-DB)

### What the architecture says
- Central API enforces tenant policy, rate limits, and budget controls.

### What the code does
- Significant tenant/project/build and workspace data operations are executed directly from browser code against Supabase (`frontend/src/lib/supabase-db.ts`).
- Other actions go through backend API (`frontend/src/lib/api.ts`).

### Why this is critical
- Governance controls are fragmented: backend controls (budget/rate/audit) cannot uniformly apply when the browser bypasses API logic.
- Security assumptions and auditability differ per feature depending on which data path is used.

### Evidence
- Direct browser CRUD in `supabase-db.ts`.
- Mixed strategy acknowledged in comments (`no Python backend needed for basic operations`).

---

## 3) Auth and Abuse-Protection Inconsistency Across Entry Points

### What the architecture says
- API layer validates auth and enforces tenant-aware controls.

### What the code does
- `/api/generate`, `/api/swarm/analyze`, and `/api/swarm/review` do not require authenticated user context before invoking provider APIs.
- `/api/generate` rate limiting is in-memory per process/IP (not tenant-level and not durable).

### Why this is critical
- Anonymous or weakly constrained model usage path increases abuse/cost exposure.
- Horizontal scaling breaks deterministic rate limits because each instance tracks limits independently.

### Evidence
- In-memory `Map` limiter in `frontend/src/app/api/generate/route.ts`.
- No tenant/user auth gate in swarm routes.

---

## 4) Deployment/Publish Logic Duplicated in Two Stacks

### What the architecture says
- Deployment should be coordinated by control-plane services.

### What the code does
- A full Netlify publish pipeline exists in frontend API routes (`/api/publish`, `/api/publish-status`).
- Another Netlify publish/status pipeline exists in FastAPI (`/publish`, `/publish-status` backend endpoints).

### Why this is critical
- Divergent deploy behavior and status semantics can occur depending on which caller path is used.
- Operational incidents become harder to triage due to duplicated integration code and retries.

### Evidence
- `frontend/src/app/api/publish/route.ts`, `frontend/src/app/api/publish-status/route.ts`.
- `nimbusforge/api/main.py` publish endpoints and Netlify service path.

---

## 5) Neural Nexus Functionality is Split Between Proxy/Fallback and Backend Engine

### What the architecture says
- Neural Nexus is modeled as backend domain logic (`nimbusforge/nexus/*`).

### What the code does
- Frontend introduces a same-origin proxy (`/api/nexus`) with direct Supabase fallback reads when backend is unreachable.
- This duplicates read-path logic and partially bypasses backend domain boundaries.

### Why this is critical
- Nexus behavior can differ by runtime availability state (backend up vs fallback mode).
- Business logic consistency degrades when fallback path and backend evolve at different speeds.

### Evidence
- Fallback-to-Supabase in `frontend/src/app/api/nexus/route.ts`.
- Canonical engine in `nimbusforge/nexus/engine.py` and backend nexus endpoints in `nimbusforge/api/main.py`.

---

## 6) Contract/Documentation Drift vs Runtime Reality

### What the architecture says
- Contracts mention `https://api.nimbusforge.dev/v1` base URL and centralized endpoint model.

### What the code does
- Runtime client default is `http://localhost:8000` and routes are not version-prefixed (`/v1`).
- Product naming is mixed (`NimbusForge` vs `Vedaa`) across docs, comments, app metadata, and API descriptions.

### Why this is critical
- Onboarding and integrations are error-prone when docs and live routes diverge.
- Naming drift signals unresolved platform identity boundaries and stale architecture records.

### Evidence
- `docs/api_contracts.md` vs `frontend/src/lib/api.ts` vs `nimbusforge/api/main.py` metadata/comments.

---

## 7) Capability Duplication Between “Swarm” Frontend Pipeline and Backend LangGraph Pipeline

### What the architecture says
- Backend orchestrator should own planner/coder/reviewer lifecycle.

### What the code does
- Frontend hook `useGenerate` implements analyzer/coder/reviewer/fixer orchestration state machine.
- Backend already defines planner/scaffolder/coder/reviewer/committer/deployer graph.

### Why this is critical
- Team must maintain and calibrate two orchestration systems (prompts, retries, review gates, cost accounting).
- Feature parity and bug fixes are likely to diverge over time.

### Evidence
- Frontend orchestration: `frontend/src/hooks/useGenerate.ts`.
- Backend orchestration: `nimbusforge/agents/orchestrator.py`.

---

## 8) Test Coverage Focuses on Backend Units While High-Risk Frontend Control Paths Are Untested

### What the architecture says
- Mission-critical orchestration/security paths should be validated.

### What the code does
- Existing tests are mainly Python unit tests (auth basics, router enums, orchestrator helpers).
- No equivalent automated tests for Next API control-plane routes that directly call model providers/deploy flows.

### Why this is critical
- The least-governed paths (frontend serverless generation/publish routes) are also least tested.
- Regression risk is highest where architecture is already split.

### Evidence
- `tests/` scope is Python-oriented.
- No frontend route tests in repo.

---

## Priority Recommendation (Architecture Remediation Order)

1. **Choose one canonical orchestration control plane** (prefer backend FastAPI/LangGraph).
2. **Move model-provider invocation behind authenticated backend endpoints only**.
3. **Unify publish/deploy pipeline into one service layer**.
4. **Treat frontend `/api/*` routes as thin proxies only (or remove them)**.
5. **Eliminate direct browser DB writes for governed entities (tenant/project/build/usage)**.
6. **Add contract tests for endpoint shape/versioning and cross-layer compatibility**.
7. **Add integration tests for generation + publish pathways in the chosen canonical stack**.

If this order is followed, the system can regain a single enforceable architecture boundary for auth, governance, observability, and reliability.
