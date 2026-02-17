# Vedaa Platform — Architectural Ledger

## Core Architecture Decisions

### Multi-Agent Pipeline (LangGraph)
- **Planner** (Claude Opus): Architecture analysis, task breakdown
- **Scaffolder** (DeepSeek): Skeleton-first file generation for GENESIS mode
- **Coder** (Claude Sonnet): Unified diff patches for SURGICAL mode
- **Reviewer** (Claude Haiku): QA, security, structural validation
- **Sentinel**: Auto-heal loop (eslint + tsc) after every patch
- **Committer**: git apply + Docker build
- **Deployer**: Cloud Run / Fly.io / Netlify

### Context Prism (3-Layer Memory)
- **Layer 1 (HOT)**: AST dependency graph via tree-sitter regex parsing
- **Layer 2 (WARM)**: Architectural ledger (this file + app_blueprints table)
- **Layer 3 (COLD)**: pgvector embeddings for semantic search

### Genesis vs Surgical Discriminator
- Backend-enforced, NOT LLM-decided
- If target file exists → SURGICAL (diff only)
- If target file is new → GENESIS (scaffold + patch)
- LLM cannot override this classification

### Structural Constraints
- No file may exceed 120 LOC
- Types only in `src/types/`
- API logic only in `src/lib/` or `src/services/`
- Pages are composition only
- One diff per patch, one file per generation turn

### Model Routing
- Claude (Opus/Sonnet): Architecture, backend, diffs, repair
- DeepSeek: UI components, styling, layout, scaffolding
- Claude (Haiku): Review, QA, security checks

### Persistence
- Supabase Postgres with RLS (tenant_id isolation)
- pgvector for semantic search
- Supabase Storage for project source files
- All tables have RLS policies enforcing tenant isolation

## Decision Log
(New decisions are appended by the orchestrator via services/ledger.py)
