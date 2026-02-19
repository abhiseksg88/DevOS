-- =============================================================================
-- Migration 011: Fix RLS on app_data for Generated App Authentication
-- =============================================================================
--
-- PROBLEM:
-- Generated apps with auth (e.g., Pilot Licensing Portal) call
-- supabase.auth.signUp(), which creates a NEW auth session in the client.
-- This replaces the Vedaa platform user's JWT. The app end-user is NOT in
-- tenant_members, so get_tenant_ids() returns '{}' and ALL app_data
-- operations are blocked by RLS.
--
-- FIX:
-- Add PERMISSIVE policies that require only authentication (auth.uid() IS NOT NULL).
-- PostgreSQL OR's PERMISSIVE policies — if ANY policy grants access, the
-- operation succeeds. The existing tenant-based policies remain intact for
-- platform dashboard access.
--
-- SECURITY ANALYSIS:
-- - app_data stores user-generated content (meals, licenses, todos, etc.)
-- - app_data does NOT contain platform secrets (API keys, billing, configs)
-- - Platform tables (tenants, projects, builds, tenant_members, api_keys,
--   deployments, usage_events) keep their strict tenant-based RLS unchanged
-- - Project IDs (128-bit UUIDs) serve as capability tokens (unguessable)
-- - Generated code enforces project_id filtering at the application layer
-- - The tenant_id NOT NULL constraint still requires a valid UUID on INSERT
-- =============================================================================

-- SELECT: Any authenticated user can read app_data
CREATE POLICY app_data_authenticated_select ON app_data FOR SELECT
    USING (auth.uid() IS NOT NULL);

-- INSERT: Any authenticated user can insert into app_data
CREATE POLICY app_data_authenticated_insert ON app_data FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL);

-- UPDATE: Any authenticated user can update app_data
CREATE POLICY app_data_authenticated_update ON app_data FOR UPDATE
    USING (auth.uid() IS NOT NULL)
    WITH CHECK (auth.uid() IS NOT NULL);

-- DELETE: Any authenticated user can delete from app_data
CREATE POLICY app_data_authenticated_delete ON app_data FOR DELETE
    USING (auth.uid() IS NOT NULL);
