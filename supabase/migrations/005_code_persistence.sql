-- =============================================================================
-- NimbusForge: Code Persistence + Lovable-Style Deployment
-- =============================================================================
-- Adds code storage, version history, chat history, and workspace state
-- to enable full workspace persistence and public sharing via /p/[slug]
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add code storage to existing projects table
-- ---------------------------------------------------------------------------

ALTER TABLE projects ADD COLUMN IF NOT EXISTS code_files JSONB NOT NULL DEFAULT '{}';
-- Structure: { "App.js": "export default function...", "styles.css": "..." }

ALTER TABLE projects ADD COLUMN IF NOT EXISTS deployed_at TIMESTAMPTZ;
-- Track when code was last deployed to /p/[slug]

-- Index for efficient lookups by slug (used in /p/[slug] route)
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);

-- ---------------------------------------------------------------------------
-- 2. Project Versions (Version History + Rollback)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    code_files      JSONB NOT NULL,
    label           TEXT NOT NULL DEFAULT 'Auto-save',
    trigger         TEXT NOT NULL DEFAULT 'autosave',
    -- 'generation' = LLM-generated, 'autosave' = auto-saved edit, 'manual' = user save, 'rollback' = reverted to older version
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, version)
);

CREATE INDEX IF NOT EXISTS idx_project_versions_project ON project_versions(project_id, version DESC);

-- RLS: Users can only access their own project versions
ALTER TABLE project_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project versions" ON project_versions FOR SELECT
    USING (
        (SELECT tenant_id FROM projects WHERE id = project_id) = ANY(public.get_tenant_ids())
    );

CREATE POLICY "Service role can manage all versions" ON project_versions FOR ALL
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 3. Chat Messages (Workspace Conversation History)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chat_messages (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at ASC);

-- RLS: Users can view chat from projects they own
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own project chat" ON chat_messages FOR SELECT
    USING (
        (SELECT tenant_id FROM projects WHERE id = project_id) = ANY(public.get_tenant_ids())
    );

CREATE POLICY "Users can insert chat to own projects" ON chat_messages FOR INSERT
    WITH CHECK (
        (SELECT tenant_id FROM projects WHERE id = project_id) = ANY(public.get_tenant_ids())
    );

CREATE POLICY "Service role can manage chat" ON chat_messages FOR ALL
    USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 4. Workspace State (UI State per User per Project)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspace_state (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL,
    active_file     TEXT,
    -- Path of the currently open file in the editor
    open_files      TEXT[] NOT NULL DEFAULT '{}',
    -- Ordered array of open tab file paths
    right_tab       TEXT NOT NULL DEFAULT 'preview',
    -- Which right panel is active: 'code' | 'preview' | 'console'
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(project_id, user_id)
);

-- RLS: Users can only manage their own workspace state
ALTER TABLE workspace_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own workspace state" ON workspace_state FOR ALL
    USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. RPC: Create Project Version (Atomic)
-- ---------------------------------------------------------------------------
-- Atomically increments version and inserts a new snapshot
-- Called after code generation or manual saves

CREATE OR REPLACE FUNCTION create_project_version(
    p_project_id UUID,
    p_code_files JSONB,
    p_label TEXT DEFAULT 'Auto-save',
    p_trigger TEXT DEFAULT 'autosave'
)
RETURNS JSONB AS $$
DECLARE
    next_version INTEGER;
    result JSONB;
BEGIN
    -- Get next version atomically
    SELECT COALESCE(MAX(version), 0) + 1 INTO next_version
    FROM project_versions
    WHERE project_id = p_project_id;

    -- Insert new version
    INSERT INTO project_versions (project_id, version, code_files, label, trigger)
    VALUES (p_project_id, next_version, p_code_files, p_label, p_trigger);

    -- Also update the current code_files on the project itself
    UPDATE projects
    SET code_files = p_code_files, deployed_at = NOW()
    WHERE id = p_project_id;

    -- Return metadata
    SELECT jsonb_build_object(
        'version', next_version,
        'label', p_label,
        'trigger', p_trigger,
        'created_at', NOW()
    ) INTO result;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Note: Triggers for updated_at are already defined in 001_core_schema.sql
-- via the trigger_set_updated_at() function and are applied globally to
-- projects and workspace_state tables.
