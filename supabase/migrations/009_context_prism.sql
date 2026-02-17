-- =============================================================
-- Migration 009: Context Prism + Platform Refactor Tables
-- Adds: build_graphs, app_blueprints, file_summaries (pgvector)
-- Updates: Adds RLS policies for all new tables
-- =============================================================

-- Enable pgvector extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================
-- build_graphs — AST dependency graph per project (Layer 1: HOT)
-- =============================================================
CREATE TABLE IF NOT EXISTS build_graphs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    graph_json  JSONB NOT NULL DEFAULT '{}',
    node_count  INTEGER NOT NULL DEFAULT 0,
    edge_count  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, project_id)
);

CREATE INDEX idx_build_graphs_project
    ON build_graphs(project_id);

ALTER TABLE build_graphs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "build_graphs_tenant_read"
    ON build_graphs FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "build_graphs_service_all"
    ON build_graphs FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- app_blueprints — Architectural Ledger entries (Layer 2: WARM)
-- =============================================================
CREATE TABLE IF NOT EXISTS app_blueprints (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    decision_type   TEXT NOT NULL DEFAULT 'note'
                    CHECK (decision_type IN (
                        'architecture', 'pattern', 'constraint',
                        'error_fix', 'stack', 'note'
                    )),
    content         TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_blueprints_project
    ON app_blueprints(project_id, created_at);

ALTER TABLE app_blueprints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blueprints_tenant_read"
    ON app_blueprints FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "blueprints_service_all"
    ON app_blueprints FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- file_summaries — Vector embeddings for semantic search (Layer 3: COLD)
-- =============================================================
CREATE TABLE IF NOT EXISTS file_summaries (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',
    content_hash    TEXT NOT NULL DEFAULT '',
    embedding       vector(1024),   -- voyage-3-lite dimension
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, file_path)
);

CREATE INDEX idx_summaries_project
    ON file_summaries(project_id);

-- HNSW index for fast vector similarity search
CREATE INDEX idx_summaries_embedding
    ON file_summaries
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

ALTER TABLE file_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "summaries_tenant_read"
    ON file_summaries FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "summaries_service_all"
    ON file_summaries FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- design_contracts — Design system tokens per project
-- =============================================================
CREATE TABLE IF NOT EXISTS design_contracts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contract_json   JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, project_id)
);

ALTER TABLE design_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contracts_tenant_read"
    ON design_contracts FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "contracts_service_all"
    ON design_contracts FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- api_contracts — API specification per project
-- =============================================================
CREATE TABLE IF NOT EXISTS api_contracts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    contract_md     TEXT NOT NULL DEFAULT '',
    openapi_json    JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, project_id)
);

ALTER TABLE api_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_contracts_tenant_read"
    ON api_contracts FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "api_contracts_service_all"
    ON api_contracts FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- patches — Individual patch history for audit trail
-- =============================================================
CREATE TABLE IF NOT EXISTS patches (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    build_id        UUID NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,
    diff_content    TEXT NOT NULL,
    mode            TEXT NOT NULL DEFAULT 'surgical'
                    CHECK (mode IN ('genesis', 'surgical')),
    applied         BOOLEAN NOT NULL DEFAULT false,
    apply_method    TEXT,  -- 'direct', '3way', 'reject'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patches_build
    ON patches(build_id);

ALTER TABLE patches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "patches_tenant_read"
    ON patches FOR SELECT
    USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY "patches_service_all"
    ON patches FOR ALL
    USING (true)
    WITH CHECK (true);

-- =============================================================
-- RPC: Vector similarity search function
-- =============================================================
CREATE OR REPLACE FUNCTION match_file_summaries(
    query_embedding vector(1024),
    match_tenant_id UUID,
    match_project_id UUID,
    match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    file_path TEXT,
    summary TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        fs.id,
        fs.file_path,
        fs.summary,
        1 - (fs.embedding <=> query_embedding) AS similarity
    FROM file_summaries fs
    WHERE fs.tenant_id = match_tenant_id
      AND fs.project_id = match_project_id
      AND fs.embedding IS NOT NULL
    ORDER BY fs.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- =============================================================
-- Updated timestamp trigger
-- =============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_build_graphs_updated
    BEFORE UPDATE ON build_graphs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_file_summaries_updated
    BEFORE UPDATE ON file_summaries
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_design_contracts_updated
    BEFORE UPDATE ON design_contracts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_api_contracts_updated
    BEFORE UPDATE ON api_contracts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at();
