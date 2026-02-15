export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  monthly_budget_usd: number;
  monthly_spent_usd: number;
  created_at: string;
}

export interface Project {
  id: string;
  tenant_id: string;
  name: string;
  slug: string;
  description: string;
  status: "active" | "archived" | "suspended";
  stack: Record<string, string>;
  created_at: string;
  updated_at: string;
  // Netlify deployment fields
  netlify_site_id?: string;
  deployed_url?: string;
  deployed_at?: string;
  deployment_status?: "not_deployed" | "deploying" | "deployed" | "failed";
  custom_domain?: string;
}

export interface PublishResult {
  deploy_id: string;
  url: string;
  status: string;
  netlify_site_id: string;
}

export interface PublishStatus {
  state: string;
  url: string;
}

export type BuildStatus =
  | "queued"
  | "planning"
  | "scaffolding"
  | "coding"
  | "reviewing"
  | "building"
  | "deploying"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Build {
  id: string;
  tenant_id: string;
  project_id: string;
  status: BuildStatus;
  prompt: string;
  files_changed: string[];
  commit_sha: string | null;
  image_tag: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface BuildEvent {
  id: string;
  build_id: string;
  kind: string;
  agent: string | null;
  payload: Record<string, unknown>;
  seq: number;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  build_id: string;
  status: string;
  provider: string;
  region: string;
  image_tag: string;
  preview_url: string | null;
  service_name: string | null;
  traffic_pct: number;
  created_at: string;
}

export interface UsageSummary {
  tenant_id: string;
  period: string;
  total_builds: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  by_model: Record<string, unknown>;
}

/** Chat message in the workspace */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  buildId?: string;
  status?: BuildStatus;
}

/** File node in the editor tree */
export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: FileNode[];
  content?: string;
  language?: string;
}
