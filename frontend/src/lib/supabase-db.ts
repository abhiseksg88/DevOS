/**
 * Supabase direct DB layer.
 * Uses the browser Supabase client to perform tenant/project CRUD
 * directly (no Python backend needed for basic operations).
 * Build/deploy operations still go through the backend API.
 */

import { createClient } from "./supabase";
import type { Tenant, Project, Build } from "@/types";

// ---------------------------------------------------------------------------
// Tenants
// ---------------------------------------------------------------------------

export async function listTenants(): Promise<Tenant[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, slug, plan, monthly_budget_usd, monthly_spent_usd, created_at")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Tenant[];
}

export async function createTenant(name: string, slug: string): Promise<Tenant> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_tenant_with_owner", {
    tenant_name: name,
    tenant_slug: slug,
  });

  if (error) throw new Error(error.message);
  return data as Tenant;
}

export async function getTenant(id: string): Promise<Tenant> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select("id, name, slug, plan, monthly_budget_usd, monthly_spent_usd, created_at")
    .eq("id", id)
    .single();

  if (error) throw new Error(error.message);
  return data as Tenant;
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(tenantId: string): Promise<Project[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, tenant_id, name, slug, description, status, stack, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Project[];
}

export async function createProject(
  tenantId: string,
  name: string,
  slug: string,
  description: string,
  stack: Record<string, string>
): Promise<Project> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_project_for_tenant", {
    p_tenant_id: tenantId,
    p_name: name,
    p_slug: slug,
    p_description: description,
    p_stack: stack,
  });

  if (error) throw new Error(error.message);
  return data as Project;
}

export async function getProject(tenantId: string, projectId: string): Promise<Project> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, tenant_id, name, slug, description, status, stack, created_at, updated_at")
    .eq("tenant_id", tenantId)
    .eq("id", projectId)
    .single();

  if (error) throw new Error(error.message);
  return data as Project;
}

// ---------------------------------------------------------------------------
// Builds (read-only from Supabase, creation goes through backend API)
// ---------------------------------------------------------------------------

export async function listBuilds(tenantId: string, projectId: string): Promise<Build[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("builds")
    .select("*")
    .eq("tenant_id", tenantId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Build[];
}
