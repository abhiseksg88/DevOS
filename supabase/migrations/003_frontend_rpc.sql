-- =============================================================================
-- NimbusForge Frontend RPC Functions
-- These functions allow the browser client (anon key + user JWT) to create
-- tenants and projects without needing the Python backend.
-- All use SECURITY DEFINER to bypass RLS safely.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Create a tenant and add the current user as owner (atomic)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_tenant_with_owner(
    tenant_name TEXT,
    tenant_slug TEXT
)
RETURNS JSONB AS $$
DECLARE
    new_tenant_id UUID;
    result JSONB;
BEGIN
    -- Ensure user is authenticated
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    -- Create the tenant
    INSERT INTO tenants (name, slug, plan, monthly_budget_usd, monthly_spent_usd)
    VALUES (tenant_name, tenant_slug, 'free', 10.00, 0.00)
    RETURNING id INTO new_tenant_id;

    -- Add the creator as owner
    INSERT INTO tenant_members (tenant_id, user_id, role)
    VALUES (new_tenant_id, auth.uid(), 'owner');

    -- Return the full tenant row as JSON
    SELECT jsonb_build_object(
        'id', t.id,
        'name', t.name,
        'slug', t.slug,
        'plan', t.plan,
        'monthly_budget_usd', t.monthly_budget_usd,
        'monthly_spent_usd', t.monthly_spent_usd,
        'created_at', t.created_at
    ) INTO result
    FROM tenants t
    WHERE t.id = new_tenant_id;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Create a project within a tenant (validates membership)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_project_for_tenant(
    p_tenant_id UUID,
    p_name TEXT,
    p_slug TEXT,
    p_description TEXT DEFAULT '',
    p_stack JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB AS $$
DECLARE
    user_role tenant_role;
    new_project_id UUID;
    result JSONB;
BEGIN
    -- Verify user is a member with write access
    SELECT role INTO user_role
    FROM tenant_members
    WHERE tenant_id = p_tenant_id AND user_id = auth.uid();

    IF user_role IS NULL THEN
        RAISE EXCEPTION 'Not a member of this tenant';
    END IF;

    IF user_role NOT IN ('owner', 'admin', 'member') THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;

    -- Create the project
    INSERT INTO projects (tenant_id, name, slug, description, stack)
    VALUES (p_tenant_id, p_name, p_slug, p_description, p_stack)
    RETURNING id INTO new_project_id;

    -- Return the full project row as JSON
    SELECT jsonb_build_object(
        'id', p.id,
        'tenant_id', p.tenant_id,
        'name', p.name,
        'slug', p.slug,
        'description', p.description,
        'status', p.status,
        'stack', p.stack,
        'created_at', p.created_at,
        'updated_at', p.updated_at
    ) INTO result
    FROM projects p
    WHERE p.id = new_project_id;

    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
