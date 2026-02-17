-- ============================================================================
-- 008: Neural Nexus — The Shared State Engine
-- ============================================================================
-- Three-dimensional knowledge graph powering the agent swarm:
--   1. User Persona Protocol (UPP) — preferences, role, history
--   2. Project State Matrix (PSM) — codebase understanding, dependency graph, tech debt
--   3. Business Logic Layer — why code exists, not just what it does
-- Plus a feedback flywheel that learns from every interaction.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. User Persona Protocol (UPP)
-- ---------------------------------------------------------------------------
-- Tracks user preferences, expertise level, coding style, and historical
-- decisions so agents can personalize their output.

create table if not exists user_persona (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  user_id     uuid not null,

  -- Preferences (learned from interactions)
  preferences jsonb not null default '{}'::jsonb,
    -- Example: {
    --   "coding_style": "functional",
    --   "framework_prefs": {"state": "zustand", "css": "tailwind", "orm": "prisma"},
    --   "library_prefs": {"redis": "ioredis", "http": "axios"},
    --   "dislikes": ["useEffect without deps", "prop drilling", "any type"],
    --   "spelling": "british",
    --   "verbosity": "concise"
    -- }

  -- Role & expertise assessment
  expertise   jsonb not null default '{}'::jsonb,
    -- Example: {
    --   "frontend": "intermediate",
    --   "backend": "expert",
    --   "devops": "novice",
    --   "database": "intermediate",
    --   "security": "beginner",
    --   "primary_languages": ["typescript", "python"],
    --   "explanation_depth": "brief"  -- agents adjust based on this
    -- }

  -- Historical decisions (what worked, what didn't)
  history     jsonb not null default '[]'::jsonb,
    -- Array of { decision, outcome, timestamp }
    -- Example: [
    --   { "decision": "Used Redis for caching", "outcome": "failed", "reason": "Heroku doesn't support Redis", "ts": "..." },
    --   { "decision": "Switched to Upstash Redis", "outcome": "success", "ts": "..." }
    -- ]

  -- Interaction stats
  total_prompts      int not null default 0,
  total_accepted     int not null default 0,
  total_rejected     int not null default 0,
  acceptance_rate    numeric(5,4) generated always as (
    case when total_prompts > 0 then total_accepted::numeric / total_prompts else 0 end
  ) stored,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (tenant_id, user_id)
);

-- RLS
alter table user_persona enable row level security;

create policy "user_persona_tenant_access" on user_persona
  for all using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 2. Project State Matrix (PSM)
-- ---------------------------------------------------------------------------
-- Real-time understanding of the codebase: file graph, dependencies,
-- component relationships, and technical debt register.

create table if not exists project_state_matrix (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,

  -- AST-derived codebase map
  file_graph  jsonb not null default '{}'::jsonb,
    -- Example: {
    --   "src/app/page.tsx": {
    --     "type": "react_component",
    --     "exports": ["default:Home"],
    --     "imports": ["react:useState,useEffect", "./components/Header"],
    --     "hooks_used": ["useState", "useEffect"],
    --     "lines": 142,
    --     "complexity": "medium"
    --   }
    -- }

  -- Dependency graph (what calls what)
  dependency_graph jsonb not null default '{}'::jsonb,
    -- Example: {
    --   "services": {
    --     "api": { "calls": ["supabase", "stripe"], "called_by": ["page.tsx", "dashboard.tsx"] },
    --     "auth": { "calls": ["supabase"], "called_by": ["middleware.ts", "login.tsx"] }
    --   },
    --   "components": {
    --     "Header": { "used_by": ["page.tsx", "dashboard.tsx"], "props": ["title", "user"] }
    --   }
    -- }

  -- Technical debt register (agents tag messy code)
  tech_debt   jsonb not null default '[]'::jsonb,
    -- Array of { file, line, severity, description, tagged_by, tagged_at }
    -- Example: [
    --   { "file": "src/api.ts", "severity": "high", "description": "N+1 query in user list", "tagged_by": "sentinel" },
    --   { "file": "src/utils.ts", "severity": "low", "description": "Unused helper function", "tagged_by": "staff_engineer" }
    -- ]

  -- Package/dependency inventory
  dependencies jsonb not null default '{}'::jsonb,
    -- { "name": "version", ... }

  -- Overall health score (0-100, computed by agents)
  health_score  int not null default 100,

  -- Timestamps
  last_analyzed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (project_id)
);

-- RLS
alter table project_state_matrix enable row level security;

create policy "psm_tenant_access" on project_state_matrix
  for all using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 3. Business Logic Layer
-- ---------------------------------------------------------------------------
-- Captures WHY code exists, not just what it does.
-- Each entry maps a code entity to its business purpose.

create table if not exists business_logic (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,

  -- What code entity this documents
  entity_type text not null,  -- 'function', 'component', 'api_route', 'table', 'hook', 'module'
  entity_path text not null,  -- 'src/lib/vat.ts:calculateVAT'
  entity_name text not null,  -- 'calculateVAT'

  -- Business context
  purpose     text not null,  -- "Calculates VAT for EU customers based on their country code"
  domain      text,           -- "billing", "auth", "inventory", etc.
  stakeholder text,           -- "finance team", "end user", etc.

  -- Constraints & rules
  business_rules jsonb not null default '[]'::jsonb,
    -- ["VAT rates must match EU directive 2024", "UK uses 20% flat rate"]

  -- Linked entities
  depends_on  text[] not null default '{}',  -- other entity_paths this depends on
  depended_by text[] not null default '{}',  -- entities that depend on this

  -- Metadata
  confidence  numeric(3,2) not null default 0.5,  -- 0.0 = guess, 1.0 = user-confirmed
  source      text not null default 'inferred',     -- 'inferred', 'user_stated', 'code_comment'
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  unique (project_id, entity_type, entity_path)
);

-- RLS
alter table business_logic enable row level security;

create policy "bl_tenant_access" on business_logic
  for all using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 4. Agent Feedback Loop (The Flywheel)
-- ---------------------------------------------------------------------------
-- Every interaction is recorded. Accepted code updates UPP.
-- Rejected code teaches the system what NOT to do.

create table if not exists nexus_feedback (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  user_id     uuid not null,

  -- What happened
  event_type  text not null,  -- 'code_accepted', 'code_rejected', 'preference_stated',
                               -- 'bug_reported', 'style_correction', 'library_preference',
                               -- 'architecture_decision', 'tech_debt_tagged'

  -- Context
  agent       text,           -- which agent generated the output
  prompt      text,           -- what the user asked
  response_summary text,      -- brief summary of what was generated

  -- Feedback data
  feedback    jsonb not null default '{}'::jsonb,
    -- For code_rejected: { "reason": "Use ioredis instead of node-redis", "files": ["src/cache.ts"] }
    -- For preference_stated: { "key": "library_prefs.redis", "value": "ioredis" }
    -- For style_correction: { "pattern": "always use const over let", "example": "..." }

  -- Impact (what was updated in the knowledge graph)
  updates_applied jsonb not null default '[]'::jsonb,
    -- [{ "table": "user_persona", "field": "preferences.library_prefs.redis", "old": "node-redis", "new": "ioredis" }]

  created_at  timestamptz not null default now()
);

-- RLS
alter table nexus_feedback enable row level security;

create policy "feedback_tenant_access" on nexus_feedback
  for all using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- Index for fast retrieval of recent feedback
create index if not exists idx_nexus_feedback_project
  on nexus_feedback (project_id, created_at desc);

create index if not exists idx_nexus_feedback_user
  on nexus_feedback (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. Agent Execution Log
-- ---------------------------------------------------------------------------
-- Tracks which agent did what, when, with what model, and the result.
-- Powers the "Agent Activity" panel in the frontend.

create table if not exists agent_executions (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  project_id  uuid not null references projects(id) on delete cascade,
  build_id    uuid references builds(id) on delete set null,

  -- Agent identity
  agent_role  text not null,  -- 'shadow_cto', 'staff_engineer', 'principal_builder', 'red_team_sentinel', 'devops_lead'
  agent_step  text not null,  -- 'plan', 'review_architecture', 'generate_code', 'security_audit', 'deploy'

  -- Model used
  model_tier  text not null,  -- 'opus', 'sonnet', 'haiku', 'deepseek'
  model_id    text,           -- actual model identifier

  -- Input/output
  input_summary  text,        -- brief description of input
  output_summary text,        -- brief description of output
  output_artifact jsonb,      -- the actual output (plan, code, review, etc.)

  -- Metrics
  tokens_in   int not null default 0,
  tokens_out  int not null default 0,
  cost_usd    numeric(10,6) not null default 0,
  latency_ms  int not null default 0,

  -- Status
  status      text not null default 'running',  -- 'running', 'succeeded', 'failed', 'rejected'
  error       text,

  started_at  timestamptz not null default now(),
  completed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- RLS
alter table agent_executions enable row level security;

create policy "executions_tenant_access" on agent_executions
  for all using (
    tenant_id in (select tenant_id from tenant_members where user_id = auth.uid())
  );

-- Index for agent activity feed
create index if not exists idx_agent_executions_project
  on agent_executions (project_id, created_at desc);

-- Enable realtime on agent executions (for live activity feed)
alter publication supabase_realtime add table agent_executions;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Auto-update timestamps
create or replace function update_neural_nexus_timestamp()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_user_persona_updated
  before update on user_persona
  for each row execute function update_neural_nexus_timestamp();

create trigger trg_psm_updated
  before update on project_state_matrix
  for each row execute function update_neural_nexus_timestamp();

create trigger trg_business_logic_updated
  before update on business_logic
  for each row execute function update_neural_nexus_timestamp();
