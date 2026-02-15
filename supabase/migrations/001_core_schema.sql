-- =============================================================================
-- NimbusForge Core Schema
-- Multi-tenant AI Cloud Application Builder
-- =============================================================================
-- Run with: supabase db push
-- All tables have tenant_id with strict RLS. No exceptions.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Custom Types
-- ---------------------------------------------------------------------------
CREATE TYPE tenant_role AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE project_status AS ENUM ('active', 'archived', 'suspended');
CREATE TYPE build_status AS ENUM ('queued', 'planning', 'scaffolding', 'coding', 'reviewing', 'building', 'deploying', 'succeeded', 'failed', 'cancelled');
CREATE TYPE deployment_status AS ENUM ('pending', 'active', 'draining', 'stopped', 'failed', 'rolled_back');
CREATE TYPE build_event_kind AS ENUM ('log', 'agent_start', 'agent_end', 'patch', 'test_result', 'build_progress', 'deploy_progress', 'error', 'warning', 'info');
CREATE TYPE model_tier AS ENUM ('opus', 'sonnet', 'haiku', 'deepseek');
CREATE TYPE plan_tier AS ENUM ('free', 'pro', 'enterprise');

-- ---------------------------------------------------------------------------
-- 1. Tenants (organizations)
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL UNIQUE,
    plan            plan_tier NOT NULL DEFAULT 'free',
    monthly_budget_usd NUMERIC(10, 2) NOT NULL DEFAULT 10.00,
    monthly_spent_usd  NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    settings        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenants_slug ON tenants(slug);

-- ---------------------------------------------------------------------------
-- 2. Tenant Members (users <-> tenants)
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_members (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    role        tenant_role NOT NULL DEFAULT 'member',
    invited_by  UUID REFERENCES auth.users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, user_id)
);

CREATE INDEX idx_tenant_members_tenant ON tenant_members(tenant_id);
CREATE INDEX idx_tenant_members_user ON tenant_members(user_id);

-- ---------------------------------------------------------------------------
-- 3. Projects
-- ---------------------------------------------------------------------------
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    slug            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    status          project_status NOT NULL DEFAULT 'active',
    stack           JSONB NOT NULL DEFAULT '{}',       -- {"framework":"nextjs","language":"typescript",...}
    repo_url        TEXT,                               -- external git repo if connected
    settings        JSONB NOT NULL DEFAULT '{}',
    -- Memory files (also committed to repo, but cached here for fast retrieval)
    architecture_md     TEXT NOT NULL DEFAULT '',
    api_contracts_md    TEXT NOT NULL DEFAULT '',
    design_system_json  JSONB NOT NULL DEFAULT '{}',
    project_manifest    JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, slug)
);

CREATE INDEX idx_projects_tenant ON projects(tenant_id);
CREATE INDEX idx_projects_tenant_status ON projects(tenant_id, status);

-- ---------------------------------------------------------------------------
-- 4. Builds
-- ---------------------------------------------------------------------------
CREATE TABLE builds (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id),
    status          build_status NOT NULL DEFAULT 'queued',
    prompt          TEXT NOT NULL,                       -- user's natural language request
    plan_json       JSONB,                              -- planner output (cached)
    patches         JSONB NOT NULL DEFAULT '[]',        -- array of unified diffs
    files_changed   TEXT[] NOT NULL DEFAULT '{}',
    commit_sha      TEXT,
    image_tag       TEXT,                               -- container image tag
    model_usage     JSONB NOT NULL DEFAULT '{}',        -- {"opus":{"in":0,"out":0},"sonnet":{...},...}
    total_tokens_in     INTEGER NOT NULL DEFAULT 0,
    total_tokens_out    INTEGER NOT NULL DEFAULT 0,
    total_cost_usd      NUMERIC(10, 6) NOT NULL DEFAULT 0,
    error_message   TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_builds_tenant ON builds(tenant_id);
CREATE INDEX idx_builds_project ON builds(project_id);
CREATE INDEX idx_builds_project_status ON builds(project_id, status);
CREATE INDEX idx_builds_tenant_created ON builds(tenant_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Build Events (streaming log entries)
-- ---------------------------------------------------------------------------
CREATE TABLE build_events (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    build_id    UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    kind        build_event_kind NOT NULL,
    agent       model_tier,                             -- which model produced this
    payload     JSONB NOT NULL DEFAULT '{}',            -- flexible: {message, diff, test_output, ...}
    seq         INTEGER NOT NULL,                       -- ordering within build
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_build_events_build ON build_events(build_id, seq);
CREATE INDEX idx_build_events_tenant ON build_events(tenant_id);

-- Enable Supabase Realtime on build_events for live streaming
ALTER PUBLICATION supabase_realtime ADD TABLE build_events;

-- ---------------------------------------------------------------------------
-- 6. Deployments
-- ---------------------------------------------------------------------------
CREATE TABLE deployments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    build_id        UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    status          deployment_status NOT NULL DEFAULT 'pending',
    provider        TEXT NOT NULL DEFAULT 'cloudrun',   -- 'cloudrun' | 'flyio'
    region          TEXT NOT NULL DEFAULT 'us-central1',
    image_tag       TEXT NOT NULL,
    preview_url     TEXT,
    service_name    TEXT,                               -- Cloud Run service or Fly app name
    revision_id     TEXT,                               -- provider-specific revision
    previous_revision_id TEXT,                          -- for rollback
    health_check_url TEXT,
    last_health_at  TIMESTAMPTZ,
    traffic_pct     INTEGER NOT NULL DEFAULT 100,       -- for canary deploys
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deployments_tenant ON deployments(tenant_id);
CREATE INDEX idx_deployments_project ON deployments(project_id);
CREATE INDEX idx_deployments_project_status ON deployments(project_id, status);
CREATE INDEX idx_deployments_preview ON deployments(preview_url) WHERE preview_url IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 7. Usage Events (audit log + cost tracking)
-- ---------------------------------------------------------------------------
CREATE TABLE usage_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES auth.users(id),
    build_id        UUID REFERENCES builds(id),
    event_type      TEXT NOT NULL,                      -- 'llm_call', 'build', 'deploy', 'api_call'
    model           model_tier,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(10, 6) NOT NULL DEFAULT 0,
    latency_ms      INTEGER,
    metadata        JSONB NOT NULL DEFAULT '{}',        -- endpoint, status_code, error, etc.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_events_tenant ON usage_events(tenant_id);
CREATE INDEX idx_usage_events_tenant_created ON usage_events(tenant_id, created_at DESC);
CREATE INDEX idx_usage_events_tenant_type ON usage_events(tenant_id, event_type);
-- Partition-ready: can partition by created_at monthly for scale

-- ---------------------------------------------------------------------------
-- 8. Plan Cache (avoid redundant Opus calls)
-- ---------------------------------------------------------------------------
CREATE TABLE plan_cache (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prompt_hash     TEXT NOT NULL,                      -- SHA-256 of normalized prompt
    plan_json       JSONB NOT NULL,
    tokens_used     INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_plan_cache_lookup ON plan_cache(project_id, prompt_hash);
CREATE INDEX idx_plan_cache_expiry ON plan_cache(expires_at);

-- ---------------------------------------------------------------------------
-- 9. API Keys (for CI/CD and external integrations)
-- ---------------------------------------------------------------------------
CREATE TABLE api_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES auth.users(id),
    name            TEXT NOT NULL,
    key_hash        TEXT NOT NULL,                      -- bcrypt hash of the key
    key_prefix      TEXT NOT NULL,                      -- first 8 chars for identification
    scopes          TEXT[] NOT NULL DEFAULT '{read}',   -- 'read', 'write', 'deploy', 'admin'
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- ===========================================================================
-- ROW LEVEL SECURITY POLICIES
-- ===========================================================================
-- Principle: Users can only access rows where tenant_id matches a tenant
-- they belong to. Backend uses service-role (bypasses RLS) for writes.
-- ===========================================================================

-- Helper function: get tenant IDs for the current authenticated user
CREATE OR REPLACE FUNCTION auth.tenant_ids()
RETURNS UUID[] AS $$
    SELECT COALESCE(
        array_agg(tenant_id),
        '{}'::UUID[]
    )
    FROM tenant_members
    WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Helper function: get role for current user in a specific tenant
CREATE OR REPLACE FUNCTION auth.tenant_role(t_id UUID)
RETURNS tenant_role AS $$
    SELECT role
    FROM tenant_members
    WHERE user_id = auth.uid() AND tenant_id = t_id
    LIMIT 1
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ---- Tenants ----
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenants_select ON tenants FOR SELECT
    USING (id = ANY(auth.tenant_ids()));

CREATE POLICY tenants_update ON tenants FOR UPDATE
    USING (auth.tenant_role(id) IN ('owner', 'admin'))
    WITH CHECK (auth.tenant_role(id) IN ('owner', 'admin'));

-- Insert/delete handled by service-role only (no user policy needed)

-- ---- Tenant Members ----
ALTER TABLE tenant_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_members_select ON tenant_members FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

CREATE POLICY tenant_members_insert ON tenant_members FOR INSERT
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

CREATE POLICY tenant_members_update ON tenant_members FOR UPDATE
    USING (auth.tenant_role(tenant_id) IN ('owner', 'admin'))
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

CREATE POLICY tenant_members_delete ON tenant_members FOR DELETE
    USING (auth.tenant_role(tenant_id) = 'owner');

-- ---- Projects ----
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY projects_select ON projects FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

CREATE POLICY projects_insert ON projects FOR INSERT
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin', 'member'));

CREATE POLICY projects_update ON projects FOR UPDATE
    USING (auth.tenant_role(tenant_id) IN ('owner', 'admin', 'member'))
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin', 'member'));

CREATE POLICY projects_delete ON projects FOR DELETE
    USING (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

-- ---- Builds ----
ALTER TABLE builds ENABLE ROW LEVEL SECURITY;

CREATE POLICY builds_select ON builds FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

-- Builds are created by the backend (service-role). No user INSERT policy.

CREATE POLICY builds_update ON builds FOR UPDATE
    USING (tenant_id = ANY(auth.tenant_ids())
           AND auth.tenant_role(tenant_id) IN ('owner', 'admin', 'member'))
    WITH CHECK (tenant_id = ANY(auth.tenant_ids()));

-- ---- Build Events ----
ALTER TABLE build_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY build_events_select ON build_events FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

-- Insert by service-role only (backend writes build events)

-- ---- Deployments ----
ALTER TABLE deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY deployments_select ON deployments FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

CREATE POLICY deployments_update ON deployments FOR UPDATE
    USING (auth.tenant_role(tenant_id) IN ('owner', 'admin'))
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

-- ---- Usage Events ----
ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_events_select ON usage_events FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

-- Insert by service-role only

-- ---- Plan Cache ----
ALTER TABLE plan_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_cache_select ON plan_cache FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

-- ---- API Keys ----
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY api_keys_select ON api_keys FOR SELECT
    USING (tenant_id = ANY(auth.tenant_ids()));

CREATE POLICY api_keys_insert ON api_keys FOR INSERT
    WITH CHECK (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

CREATE POLICY api_keys_delete ON api_keys FOR DELETE
    USING (auth.tenant_role(tenant_id) IN ('owner', 'admin'));

-- ===========================================================================
-- Storage Policies (Supabase Storage)
-- ===========================================================================
-- Bucket: project-assets
-- Path convention: {tenant_id}/{project_id}/...
-- Users can only access paths where the first segment matches their tenant_id
-- ===========================================================================

-- NOTE: Execute these via Supabase dashboard or storage API:
-- INSERT INTO storage.buckets (id, name, public) VALUES ('project-assets', 'project-assets', false);
--
-- Storage RLS policy (pseudo):
-- SELECT: bucket_id = 'project-assets' AND (storage.foldername(name))[1]::uuid = ANY(auth.tenant_ids())
-- INSERT: bucket_id = 'project-assets' AND (storage.foldername(name))[1]::uuid = ANY(auth.tenant_ids())
-- DELETE: bucket_id = 'project-assets' AND (storage.foldername(name))[1]::uuid = ANY(auth.tenant_ids())

-- ===========================================================================
-- Utility: Updated_at trigger
-- ===========================================================================
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tenant_members FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON builds FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ===========================================================================
-- Utility: Monthly budget reset (run via pg_cron or Supabase scheduled function)
-- ===========================================================================
-- SELECT cron.schedule('reset-monthly-budgets', '0 0 1 * *', $$
--     UPDATE tenants SET monthly_spent_usd = 0, updated_at = NOW();
-- $$);
