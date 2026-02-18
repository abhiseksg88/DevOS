-- ============================================================
-- Migration 010: Phases 1-4 — HITL, Component RAG, Observability
-- ============================================================

-- 1. Add awaiting_approval to build_status enum
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'awaiting_approval'
        AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'build_status')
    ) THEN
        ALTER TYPE build_status ADD VALUE 'awaiting_approval' AFTER 'planning';
    END IF;
END $$;

-- 2. Add plan_json column to builds table for HITL checkpoint
ALTER TABLE builds ADD COLUMN IF NOT EXISTS plan_json JSONB;
ALTER TABLE builds ADD COLUMN IF NOT EXISTS user_id UUID;

-- ============================================================
-- Component Library — Dimension 4 of Neural Nexus
-- ============================================================
CREATE TABLE IF NOT EXISTS component_library (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    component_name  TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    props_schema    JSONB NOT NULL DEFAULT '{}',
    preview_html    TEXT,
    embedding       vector(1024),
    tags            TEXT[] NOT NULL DEFAULT '{}',
    usage_count     INTEGER NOT NULL DEFAULT 0,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, file_path, component_name)
);

CREATE INDEX IF NOT EXISTS idx_component_library_project
    ON component_library(project_id);

CREATE INDEX IF NOT EXISTS idx_component_library_embedding
    ON component_library
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);

ALTER TABLE component_library ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'component_library' AND policyname = 'component_library_tenant_read') THEN
        CREATE POLICY component_library_tenant_read
            ON component_library FOR SELECT
            USING (tenant_id = ANY(get_tenant_ids()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'component_library' AND policyname = 'component_library_service_all') THEN
        CREATE POLICY component_library_service_all
            ON component_library FOR ALL
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;

-- RPC for component similarity search
CREATE OR REPLACE FUNCTION match_components(
    query_embedding vector(1024),
    match_project_id UUID,
    match_count INTEGER DEFAULT 5
)
RETURNS TABLE (
    id UUID,
    component_name TEXT,
    file_path TEXT,
    props_schema JSONB,
    tags TEXT[],
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        cl.id,
        cl.component_name,
        cl.file_path,
        cl.props_schema,
        cl.tags,
        1 - (cl.embedding <=> query_embedding) AS similarity
    FROM component_library cl
    WHERE cl.project_id = match_project_id
      AND cl.embedding IS NOT NULL
    ORDER BY cl.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- ============================================================
-- Observability Metrics — Dimension 5 of Neural Nexus
-- ============================================================
CREATE TABLE IF NOT EXISTS observability_metrics (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    metric_type     TEXT NOT NULL,
    period          TEXT NOT NULL,
    data            JSONB NOT NULL DEFAULT '{}',
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(project_id, metric_type, period)
);

ALTER TABLE observability_metrics ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'observability_metrics' AND policyname = 'observability_tenant_read') THEN
        CREATE POLICY observability_tenant_read
            ON observability_metrics FOR SELECT
            USING (tenant_id = ANY(get_tenant_ids()));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'observability_metrics' AND policyname = 'observability_service_all') THEN
        CREATE POLICY observability_service_all
            ON observability_metrics FOR ALL
            USING (true)
            WITH CHECK (true);
    END IF;
END $$;
