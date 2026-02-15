-- Migration 006: Netlify One-Click Publish
-- Adds Netlify deployment tracking to projects and a deployment history table.

-- 1. Add Netlify columns to projects table
ALTER TABLE projects ADD COLUMN IF NOT EXISTS netlify_site_id TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployed_url TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployment_status TEXT NOT NULL DEFAULT 'not_deployed';
-- deployment_status values: 'not_deployed', 'deploying', 'deployed', 'failed'
ALTER TABLE projects ADD COLUMN IF NOT EXISTS custom_domain TEXT;
-- custom_domain: e.g., "meal-planner.vedaa.io" (NULL if using default netlify.app only)

CREATE INDEX IF NOT EXISTS idx_projects_custom_domain ON projects(custom_domain);

-- 2. Netlify deployment history table
CREATE TABLE IF NOT EXISTS netlify_deployments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    netlify_site_id TEXT NOT NULL,
    netlify_deploy_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    -- status values: 'pending', 'uploading', 'ready', 'failed'
    url TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_netlify_deployments_project
    ON netlify_deployments(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_netlify_deployments_tenant
    ON netlify_deployments(tenant_id, created_at DESC);

-- 3. RLS for netlify_deployments
ALTER TABLE netlify_deployments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tenant members can view deploys"
    ON netlify_deployments FOR SELECT
    USING (tenant_id = ANY(public.get_tenant_ids()));

CREATE POLICY "Tenant members can insert deploys"
    ON netlify_deployments FOR INSERT
    WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));
