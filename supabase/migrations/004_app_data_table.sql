-- =============================================================================
-- NimbusForge Universal App Data Table
-- Single flexible JSONB table for all application data (no migrations needed)
-- Enables Meal Planner, Todo Lists, CRM, and any other app type
-- =============================================================================
-- Run with: supabase db push
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. App Data Table (Universal JSONB storage)
-- ---------------------------------------------------------------------------
-- Single table design: all entities (meals, todos, users, etc.) stored here
-- Each "collection" is a logical namespace (meals, todos, contacts, etc.)
-- The "data" column stores the actual object as flexible JSONB
-- Version field enables optimistic locking for concurrent updates
-- =============================================================================

CREATE TABLE app_data (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    app_instance_id TEXT NOT NULL,                     -- runtime app session (prevents cross-session conflicts)
    collection      TEXT NOT NULL,                     -- e.g., 'meals', 'todos', 'contacts'
    record_id       TEXT NOT NULL,                     -- user-facing ID (UUID or slug)
    data            JSONB NOT NULL,                    -- flexible schema: {name: "...", email: "...", ...}
    version         INTEGER NOT NULL DEFAULT 1,       -- optimistic locking: check version before update
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, app_instance_id, collection, record_id)
);

-- Indexes for common query patterns
CREATE INDEX idx_app_data_project_collection ON app_data(project_id, collection);
CREATE INDEX idx_app_data_lookup ON app_data(project_id, app_instance_id, collection, record_id);
CREATE INDEX idx_app_data_created ON app_data(project_id, created_at DESC);
CREATE INDEX idx_app_data_tenant ON app_data(tenant_id);

-- Enable Supabase Realtime for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE app_data;

-- ===========================================================================
-- ROW LEVEL SECURITY POLICIES
-- ===========================================================================
-- Same principle as other tables: users access only their tenant's data
-- RLS is enforced at the database level, bypassed only for service-role
-- ===========================================================================

ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;

-- SELECT: Users can read their tenant's data
CREATE POLICY app_data_select ON app_data FOR SELECT
    USING (tenant_id = ANY(public.get_tenant_ids()));

-- INSERT: Users in a tenant can insert data (backend or authenticated client)
CREATE POLICY app_data_insert ON app_data FOR INSERT
    WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));

-- UPDATE: Users can update their tenant's data (optimistic locking via version check)
CREATE POLICY app_data_update ON app_data FOR UPDATE
    USING (tenant_id = ANY(public.get_tenant_ids()))
    WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));

-- DELETE: Users can delete their tenant's data
CREATE POLICY app_data_delete ON app_data FOR DELETE
    USING (tenant_id = ANY(public.get_tenant_ids()));

-- ===========================================================================
-- Updated_at Trigger
-- ===========================================================================
CREATE TRIGGER set_updated_at BEFORE UPDATE ON app_data FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ===========================================================================
-- USAGE EXAMPLES (for reference in system prompts)
-- ===========================================================================
-- CREATE (Meal Planner):
--   INSERT INTO app_data (tenant_id, project_id, app_instance_id, collection, record_id, data)
--   VALUES (
--     '550e8400-e29b-41d4-a716-446655440000',
--     '660e8400-e29b-41d4-a716-446655440001',
--     'session-abc123',
--     'meals',
--     '770e8400-e29b-41d4-a716-446655440002',
--     '{"name": "Breakfast", "date": "2025-02-15", "items": [{"name": "Eggs", "quantity": 2}]}'
--   );
--
-- READ (Fetch all meals):
--   SELECT record_id, data, created_at FROM app_data
--   WHERE project_id = '...'
--     AND app_instance_id = '...'
--     AND collection = 'meals'
--   ORDER BY created_at DESC;
--
-- UPDATE (Add item to meal, with optimistic locking):
--   UPDATE app_data
--   SET data = '{"name": "Breakfast", "items": [...]}'::jsonb,
--       version = version + 1
--   WHERE project_id = '...'
--     AND record_id = '...'
--     AND collection = 'meals'
--     AND version = 1  -- conflict detection: if version changed, this fails
--   RETURNING record_id, data;
--
-- DELETE (Remove meal):
--   DELETE FROM app_data
--   WHERE project_id = '...'
--     AND record_id = '...'
--     AND collection = 'meals';
