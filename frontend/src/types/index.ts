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
  custom_domain?: string | null;
}

export interface PublishStatus {
  state: string;
  url: string;
}

export type BuildStatus =
  | "queued"
  | "planning"
  | "awaiting_approval"
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

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------

export type IntegrationCategory =
  | "llm"
  | "auth"
  | "database"
  | "payment"
  | "email"
  | "storage"
  | "analytics"
  | "custom";

export type IntegrationStatus = "active" | "inactive" | "error";

export interface CredentialHint {
  hint: string;
  name: string;
  is_set: boolean;
}

export interface Integration {
  id: string;
  tenant_id: string;
  project_id: string;
  provider: string;
  category: IntegrationCategory;
  display_name: string;
  status: IntegrationStatus;
  credentials: Record<string, CredentialHint>;
  config: Record<string, unknown>;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
  latency_ms: number | null;
}

export interface IntegrationContext {
  context: string;
  integrations: Array<{
    provider: string;
    category: string;
    has_credentials: boolean;
  }>;
}

/** Pipeline event for rich message rendering (mirrors useGenerate.PipelineEvent) */
export interface ChatPipelineStage {
  key: string;
  label: string;
  agent: string;
  status: "pending" | "active" | "done" | "error" | "skipped";
  meta?: { latency_ms?: number; cost_usd?: number };
}

/** Chat message in the workspace */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  buildId?: string;
  status?: BuildStatus;
  /** Rich message discriminator */
  type?: "text" | "plan" | "pipeline" | "summary" | "proposal";
  /** PRD from Analyzer (for type="plan") */
  prd?: Record<string, unknown>;
  /** Plan review status (for type="plan" and type="proposal") */
  planStatus?: "pending" | "approved" | "modified" | "building" | "completed";
  /** Generated files list (for type="summary") */
  buildFiles?: Array<{ path: string }>;
  /** Pipeline stages (for type="pipeline") */
  pipelineStages?: ChatPipelineStage[];
  /** Architecture proposal from Lead Product Architect (for type="proposal") */
  proposal?: {
    app_name?: string;
    roles?: Array<{ name: string; can?: string[] }>;
    schema?: Record<string, { fields?: string[]; owner?: string }>;
    security?: {
      auth_required?: boolean;
      rbac?: boolean;
      data_isolation?: string;
      sensitive_fields?: string[];
      audit_trail?: boolean;
    };
    screens?: string[];
  };
  /** Critical question from planner (for type="proposal") */
  criticalQuestion?: string;
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

// ---------------------------------------------------------------------------
// Neural Nexus — The Brain
// ---------------------------------------------------------------------------

export interface NexusPersona {
  preferences: Record<string, unknown>;
  expertise: Record<string, string>;
  history: Array<{
    decision: string;
    outcome: string;
    reason?: string;
    ts: string;
  }>;
  stats: {
    total_prompts: number;
    total_accepted: number;
    total_rejected: number;
    acceptance_rate: number;
  };
}

export interface NexusFileInfo {
  type: string;
  lines: number;
  imports?: string[];
  exports?: string[];
  hooks_used?: string[];
  complexity: string;
}

export interface NexusTechDebt {
  file: string;
  severity: string;
  description: string;
  tagged_by: string;
  tagged_at: string;
}

export interface NexusProjectState {
  file_graph: Record<string, NexusFileInfo>;
  dependency_graph: Record<string, unknown>;
  tech_debt: NexusTechDebt[];
  health_score: number;
  last_analyzed_at: string | null;
}

export interface NexusBusinessLogic {
  entity_type: string;
  entity_path: string;
  entity_name: string;
  purpose: string;
  domain: string | null;
  confidence: number;
}

export interface NexusFeedback {
  event_type: string;
  agent: string | null;
  feedback: Record<string, unknown>;
  created_at: string;
}

export interface NexusAgentExecution {
  id: string;
  agent_role: string;
  agent_step: string;
  model_tier: string;
  status: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  input_summary: string | null;
  output_summary: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface NexusState {
  user_persona: NexusPersona;
  project_state: NexusProjectState;
  business_logic: NexusBusinessLogic[];
  recent_feedback: NexusFeedback[];
  agent_activity: NexusAgentExecution[];
}

// ---------------------------------------------------------------------------
// Figma Visual Integration Layer
// ---------------------------------------------------------------------------

export type FigmaComponentType =
  | "button"
  | "card"
  | "form"
  | "input"
  | "table"
  | "layout"
  | "text"
  | "image"
  | "nav"
  | "unknown";

export type FigmaSyncStatus =
  | "disconnected"
  | "connecting"
  | "synced"
  | "error";

export interface FigmaConfig {
  enabled: boolean;
  fileKey: string;
  lastSynced: string | null;
  syncStatus: FigmaSyncStatus;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  boundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  children?: FigmaNode[];
  styles?: Record<string, unknown>;
}

export interface FigmaComponent {
  id: string;
  name: string;
  type: string;
  description?: string;
  thumbnailUrl?: string;
}

export interface FigmaComponentMapping {
  figmaId: string;
  figmaName: string;
  componentType: FigmaComponentType;
  tailwindClasses: string;
  props: Record<string, unknown>;
  confidence: number;
  action: "create" | "extend" | "ignore";
}

export interface FigmaDesignState {
  config: FigmaConfig;
  components: FigmaComponent[];
  mappings: FigmaComponentMapping[];
  componentHashMap: Record<string, string>;
  nodeTree: FigmaNode | null;
  error: string | null;
}
