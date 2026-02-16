-- =============================================================================
-- 007: Project Integrations — Connectors & Secrets Vault
-- =============================================================================
-- Stores per-project integration configurations: API keys, service connections,
-- and settings for LLM providers, auth, payment, email, storage, analytics.
-- Secrets are stored encrypted (via pgcrypto) or as masked hashes — the backend
-- holds the plaintext transiently and only stores the last 4 chars for display.
-- =============================================================================

-- Integration category enum
CREATE TYPE integration_category AS ENUM (
  'llm',
  'auth',
  'database',
  'payment',
  'email',
  'storage',
  'analytics',
  'custom'
);

-- Integration status
CREATE TYPE integration_status AS ENUM (
  'active',
  'inactive',
  'error'
);

-- =============================================================================
-- project_integrations table
-- =============================================================================
CREATE TABLE project_integrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Integration identity
  provider      TEXT NOT NULL,           -- e.g. 'openai', 'stripe', 'resend', 'clerk'
  category      integration_category NOT NULL,
  display_name  TEXT NOT NULL,           -- e.g. 'OpenAI GPT-4', 'Stripe Payments'
  status        integration_status NOT NULL DEFAULT 'inactive',

  -- Credentials (encrypted at rest via Supabase vault or app-level encryption)
  -- We store: encrypted blob + last 4 chars for UI display + key name
  credentials   JSONB NOT NULL DEFAULT '{}',
  -- Example: {"api_key": {"encrypted": "...", "hint": "...sk-1234", "name": "API Key"}}

  -- Configuration (non-secret settings)
  config        JSONB NOT NULL DEFAULT '{}',
  -- Example: {"model": "gpt-4o", "temperature": 0.7} or {"webhook_url": "..."}

  -- Metadata
  last_tested_at  TIMESTAMPTZ,
  last_test_ok    BOOLEAN,
  last_error      TEXT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One integration per provider per project
  UNIQUE (project_id, provider)
);

-- Indexes
CREATE INDEX idx_integrations_tenant ON project_integrations(tenant_id);
CREATE INDEX idx_integrations_project ON project_integrations(project_id);
CREATE INDEX idx_integrations_category ON project_integrations(project_id, category);

-- RLS
ALTER TABLE project_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY integrations_select ON project_integrations
  FOR SELECT USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY integrations_insert ON project_integrations
  FOR INSERT WITH CHECK (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY integrations_update ON project_integrations
  FOR UPDATE USING (tenant_id = ANY(get_tenant_ids()));

CREATE POLICY integrations_delete ON project_integrations
  FOR DELETE USING (
    tenant_id = ANY(get_tenant_ids())
    AND get_tenant_role(tenant_id) IN ('owner', 'admin')
  );

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_integration_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_integration_updated
  BEFORE UPDATE ON project_integrations
  FOR EACH ROW EXECUTE FUNCTION update_integration_timestamp();
