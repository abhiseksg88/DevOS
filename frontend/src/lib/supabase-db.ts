/**
 * Supabase direct DB layer.
 * Uses the browser Supabase client to perform tenant/project CRUD
 * directly (no Python backend needed for basic operations).
 * Build/deploy operations still go through the backend API.
 */

import { createClient } from "./supabase/client";
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

// ---------------------------------------------------------------------------
// Code Persistence (Project Code + Versions)
// ---------------------------------------------------------------------------

/**
 * Save code files to the project's current code_files column.
 * Also creates a version snapshot via RPC.
 */
export async function updateProjectCode(
  projectId: string,
  codeFiles: Record<string, string>,
  trigger: 'generation' | 'autosave' | 'manual' = 'autosave',
  label?: string
): Promise<{ version: number }> {
  const supabase = createClient();

  // Call RPC to atomically update code and create version
  const { data, error } = await supabase.rpc('create_project_version', {
    p_project_id: projectId,
    p_code_files: codeFiles,
    p_label: label ?? trigger,
    p_trigger: trigger,
  });

  if (error) throw new Error(error.message);
  return data as { version: number };
}

/**
 * Fetch the current code files from a project.
 */
export async function getProjectCode(projectId: string): Promise<Record<string, string>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('projects')
    .select('code_files')
    .eq('id', projectId)
    .single();

  if (error) throw new Error(error.message);
  return (data?.code_files ?? {}) as Record<string, string>;
}

/**
 * List all versions of a project (for version history UI).
 */
export async function listProjectVersions(
  projectId: string
): Promise<Array<{ version: number; label: string; trigger: string; created_at: string }>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('project_versions')
    .select('version, label, trigger, created_at')
    .eq('project_id', projectId)
    .order('version', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ version: number; label: string; trigger: string; created_at: string }>;
}

/**
 * Fetch code from a specific version.
 */
export async function getProjectVersion(
  projectId: string,
  version: number
): Promise<Record<string, string>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('project_versions')
    .select('code_files')
    .eq('project_id', projectId)
    .eq('version', version)
    .single();

  if (error) throw new Error(error.message);
  return (data?.code_files ?? {}) as Record<string, string>;
}

// ---------------------------------------------------------------------------
// Chat Messages (Workspace Conversation History)
// ---------------------------------------------------------------------------

/**
 * Save a chat message (user or assistant).
 */
export async function saveChatMessage(
  projectId: string,
  role: 'user' | 'assistant' | 'system',
  content: string
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('chat_messages').insert({
    project_id: projectId,
    role,
    content,
  });

  if (error) throw new Error(error.message);
}

/**
 * Load all chat messages for a project.
 */
export async function loadChatMessages(
  projectId: string
): Promise<Array<{ id: string; role: string; content: string; created_at: string }>> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, role, content, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{ id: string; role: string; content: string; created_at: string }>;
}

// ---------------------------------------------------------------------------
// Workspace State (UI State)
// ---------------------------------------------------------------------------

export interface WorkspaceUIState {
  activeFile: string | null;
  openFiles: string[];
  rightTab: 'code' | 'preview' | 'console';
}

/**
 * Save the user's workspace UI state (active file, open tabs, etc).
 * Uses UPSERT so it updates if exists, inserts if not.
 */
export async function saveWorkspaceState(
  projectId: string,
  userId: string,
  state: WorkspaceUIState
): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('workspace_state').upsert({
    project_id: projectId,
    user_id: userId,
    active_file: state.activeFile,
    open_files: state.openFiles,
    right_tab: state.rightTab,
  });

  if (error) throw new Error(error.message);
}

/**
 * Load the user's saved workspace state.
 */
export async function loadWorkspaceState(
  projectId: string,
  userId: string
): Promise<WorkspaceUIState | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('workspace_state')
    .select('active_file, open_files, right_tab')
    .eq('project_id', projectId)
    .eq('user_id', userId)
    .single();

  if (error) {
    // No workspace state exists yet
    if (error.code === 'PGRST116') return null;
    throw new Error(error.message);
  }

  return {
    activeFile: data.active_file,
    openFiles: data.open_files ?? [],
    rightTab: data.right_tab ?? 'preview',
  } as WorkspaceUIState;
}
