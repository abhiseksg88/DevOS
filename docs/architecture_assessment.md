# Architecture Assessment Report — Vedaa Platform Refactor

## Executive Summary

Vedaa (DevOS) is an Agentic Development OS with a FastAPI backend, Next.js frontend,
LangGraph orchestration, Supabase persistence, and Claude/DeepSeek LLM routing.
This report identifies structural gaps and monolith points that the refactor addresses.

## Current Architecture Map

### File Structure
```
nimbusforge/          → FastAPI backend + agent orchestrator
  api/main.py         → 1689-line monolith (all endpoints)
  agents/orchestrator.py → LangGraph pipeline (663 lines)
  agents/llm_router.py   → Model dispatch + fallback (205 lines)
  agents/prompts.py       → System prompts (402 lines)
  pipeline/builder.py     → Patch apply + Docker build (419 lines)
  pipeline/deployer.py    → Cloud Run / Fly.io deploy (335 lines)
  nexus/engine.py         → Neural Nexus state manager (902 lines)
  services/netlify.py     → Netlify API client (202 lines)
frontend/             → Next.js 14 + React 18
  src/app/api/generate/route.ts → Direct Anthropic streaming (587 lines)
```

### Import Graph (Critical Paths)
```
orchestrator.py → llm_router.py → config.py
orchestrator.py → prompts.py
orchestrator.py → pipeline/builder.py
orchestrator.py → pipeline/deployer.py
api/main.py     → orchestrator.py (via run_build)
api/main.py     → dependencies.py → config.py
api/main.py     → nexus/engine.py
frontend/route.ts → Anthropic REST API (direct, no backend)
```

### Database Access Points
- `orchestrator.py`: builds, build_events, plan_cache, usage_events, projects
- `pipeline/builder.py`: project-assets storage bucket
- `pipeline/deployer.py`: deployments table
- `nexus/engine.py`: neural_nexus_state table
- `api/main.py`: all tables (tenants, projects, builds, deployments, etc.)
- `dependencies.py`: tenant_members, tenants

### LLM Invocation Points
1. **Backend orchestrator** (`orchestrator.py` → `llm_router.py`): Opus/Sonnet/Haiku/DeepSeek
2. **Frontend generate route** (`route.ts`): Direct Anthropic REST (claude-sonnet-4-5)
3. **Frontend swarm routes**: analyze + review endpoints

---

## Identified Risks

### R1 — Dual LLM Paths (CRITICAL)
The frontend (`/api/generate/route.ts`) calls Anthropic directly, bypassing the
backend orchestrator entirely. This means:
- No AST-based context pruning
- No discriminator (genesis vs surgical)
- Full file rewrites in update mode
- No ledger consultation
- No sentinel auto-heal

### R2 — Full File Context Loading
`_load_project_files()` in `orchestrator.py:635` downloads up to 50 files from
Supabase Storage with no graph-based filtering. All files are injected into the
LLM context regardless of relevance.

### R3 — No Streaming Truncation Handling
The frontend `route.ts` forwards `stop_reason` but does NOT implement stitch &
continue. If `finish_reason == "length"`, the response is silently truncated.
The backend orchestrator uses non-streaming `call_llm()` with 8192 max_tokens
default — low ceiling for complex generations.

### R4 — Missing Discriminator
There is no hard discriminator between genesis (new file) and surgical (edit
existing) modes. The planner decides via `needs_scaffold: bool` in its JSON
output — this is LLM-decided, not backend-enforced.

---

## Identified Monolith Points

### M1 — `api/main.py` (1689 lines)
All API endpoints in a single file. Should be split into route modules.

### M2 — `nexus/engine.py` (902 lines)
Monolithic state manager combining UPP, PSM, and business logic.

### M3 — Frontend `route.ts` (587 lines)
Massive system prompt + streaming logic + rate limiting in one file.

---

## Missing Components

| Component | Status |
|---|---|
| AST Graph (tree-sitter) | NOT PRESENT |
| Architectural Ledger | Partially exists as `architecture_md` on projects table |
| Vector Memory (pgvector) | NOT PRESENT |
| Genesis/Surgical Discriminator | LLM-decided, not backend-enforced |
| Skeleton-First Protocol | Scaffolder exists but no LOC/SoC enforcement |
| Stitch & Continue | NOT PRESENT |
| Sentinel Auto-Heal | NOT PRESENT (only useAutoFix hook on frontend) |
| Model routing by task type | EXISTS in llm_router.py (needs DeepSeek UI routing) |

---

## Refactor Targets

1. Create `services/ast_graph.py` — tree-sitter AST + dependency graph
2. Create `services/ledger.py` — architectural ledger read/write
3. Create `services/vector_memory.py` — pgvector semantic search
4. Create `services/discriminator.py` — hard genesis/surgical check
5. Create `services/patch_apply.py` — unified diff protocol
6. Create `services/stitch_continue.py` — truncation healing
7. Create `services/sentinel.py` — auto-heal loop
8. Update `agents/orchestrator.py` — integrate all new services
9. Update `agents/llm_router.py` — add task-type routing
10. Add Supabase migrations for new tables
11. Update `netlify.toml` for proper env mapping
