/**
 * Vedaa.io API client.
 * All calls go through the FastAPI backend.
 */

import type { Build, Deployment, Integration, IntegrationContext, IntegrationTestResult, NexusAgentExecution, NexusState, Project, PublishResult, PublishStatus, Tenant, UsageSummary } from "@/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // Network error — backend unreachable
    if (API.includes("localhost")) {
      throw new Error(
        "Backend API unreachable. Set NEXT_PUBLIC_API_URL in your environment variables to point to your deployed backend (e.g. https://your-backend.railway.app)."
      );
    }
    throw new Error(`Cannot reach backend at ${API}. This may be a CORS issue — ensure the backend allows requests from this origin. Check your NEXT_PUBLIC_API_URL and CORS settings.`);
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `API error ${res.status}`);
  }
  return res.json();
}

// --- Tenants ---
export const tenants = {
  list: (token: string) => request<Tenant[]>("GET", "/tenants", token),
  create: (token: string, data: { name: string; slug: string; plan?: string }) =>
    request<Tenant>("POST", "/tenants", token, data),
  get: (token: string, id: string) => request<Tenant>("GET", `/tenants/${id}`, token),
};

// --- Projects ---
export const projects = {
  list: (token: string, tenantId: string) =>
    request<Project[]>("GET", `/tenants/${tenantId}/projects`, token),
  create: (token: string, tenantId: string, data: { name: string; slug: string; description?: string; stack?: Record<string, string> }) =>
    request<Project>("POST", `/tenants/${tenantId}/projects`, token, data),
  get: (token: string, tenantId: string, projectId: string) =>
    request<Project>("GET", `/tenants/${tenantId}/projects/${projectId}`, token),
};

// --- Builds ---
export const builds = {
  list: (token: string, tenantId: string, projectId: string) =>
    request<Build[]>("GET", `/tenants/${tenantId}/projects/${projectId}/builds`, token),
  create: (token: string, tenantId: string, projectId: string, prompt: string) =>
    request<Build>("POST", `/tenants/${tenantId}/projects/${projectId}/builds`, token, { prompt }),
  get: (token: string, tenantId: string, projectId: string, buildId: string) =>
    request<Build>("GET", `/tenants/${tenantId}/projects/${projectId}/builds/${buildId}`, token),
  cancel: (token: string, tenantId: string, projectId: string, buildId: string) =>
    request<unknown>("POST", `/tenants/${tenantId}/projects/${projectId}/builds/${buildId}/cancel`, token),
};

// --- Deployments ---
export const deployments = {
  list: (token: string, tenantId: string, projectId: string) =>
    request<Deployment[]>("GET", `/tenants/${tenantId}/projects/${projectId}/deployments`, token),
};

// --- Publish (Netlify One-Click Deploy) ---
export interface PublishHealth {
  ready: boolean;
  netlify_configured: boolean;
  netlify_reachable: boolean;
  netlify_team: string | null;
  custom_domain: string | null;
  supabase_configured: boolean;
  netlify_error?: string;
}

export const publish = {
  /** Pre-flight health check — validates Netlify token/team before attempting publish */
  health: async (token: string): Promise<PublishHealth> => {
    try {
      return await request<PublishHealth>("GET", "/health/publish", token);
    } catch {
      return {
        ready: false,
        netlify_configured: false,
        netlify_reachable: false,
        netlify_team: null,
        custom_domain: null,
        supabase_configured: false,
        netlify_error: "Backend unreachable",
      };
    }
  },
  deploy: (token: string, tenantId: string, projectId: string, html: string) =>
    request<PublishResult>(
      "POST",
      `/tenants/${tenantId}/projects/${projectId}/publish`,
      token,
      { html },
    ),
  status: (token: string, tenantId: string, projectId: string, deployId: string) =>
    request<PublishStatus>(
      "GET",
      `/tenants/${tenantId}/projects/${projectId}/publish-status?deploy_id=${encodeURIComponent(deployId)}`,
      token,
    ),
};

// --- Integrations ---
export const integrations = {
  list: (token: string, tenantId: string, projectId: string) =>
    request<Integration[]>(
      "GET",
      `/tenants/${tenantId}/projects/${projectId}/integrations`,
      token,
    ),
  create: (
    token: string,
    tenantId: string,
    projectId: string,
    data: {
      provider: string;
      category: string;
      display_name: string;
      credentials?: Record<string, string>;
      config?: Record<string, unknown>;
    },
  ) =>
    request<Integration>(
      "POST",
      `/tenants/${tenantId}/projects/${projectId}/integrations`,
      token,
      data,
    ),
  update: (
    token: string,
    tenantId: string,
    projectId: string,
    integrationId: string,
    data: {
      display_name?: string;
      credentials?: Record<string, string>;
      config?: Record<string, unknown>;
      status?: string;
    },
  ) =>
    request<Integration>(
      "PATCH",
      `/tenants/${tenantId}/projects/${projectId}/integrations/${integrationId}`,
      token,
      data,
    ),
  delete: (token: string, tenantId: string, projectId: string, integrationId: string) =>
    fetch(
      `${API}/tenants/${tenantId}/projects/${projectId}/integrations/${integrationId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      },
    ),
  test: (token: string, tenantId: string, projectId: string, integrationId: string) =>
    request<IntegrationTestResult>(
      "POST",
      `/tenants/${tenantId}/projects/${projectId}/integrations/${integrationId}/test`,
      token,
    ),
  context: (token: string, tenantId: string, projectId: string) =>
    request<IntegrationContext>(
      "GET",
      `/tenants/${tenantId}/projects/${projectId}/integrations/context`,
      token,
    ),
};

// --- Usage ---
export const usage = {
  get: (token: string, tenantId: string, period?: string) =>
    request<UsageSummary>("GET", `/tenants/${tenantId}/usage?period=${period ?? "current_month"}`, token),
};

// --- Preview ---
export const preview = {
  getCredentials: (token: string) =>
    request<{ url: string; anonKey: string }>("GET", "/preview/credentials", token),
};

// --- Neural Nexus ---
// Nexus calls are routed through a same-origin Next.js API proxy (/api/nexus)
// to avoid CORS issues when the backend is on a different origin (e.g. Railway).

async function nexusProxy<T>(
  method: string,
  token: string,
  tenantId: string,
  projectId: string,
  action: string,
  extra?: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const params = new URLSearchParams({ tenantId, projectId, action, ...extra });
  // Same-origin call — goes to the Next.js API proxy, NOT the Railway backend
  const url = `/api/nexus?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Failed to reach Neural Nexus proxy. Please reload and try again.");
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail ?? `Neural Nexus error ${res.status}`);
  }
  return res.json();
}

export const nexus = {
  /** Get full Neural Nexus state (UPP + PSM + Business Logic + Activity) */
  getState: (token: string, tenantId: string, projectId: string) =>
    nexusProxy<NexusState>("GET", token, tenantId, projectId, "state"),
  /** Get Neural Nexus context string for code generation */
  getContext: (token: string, tenantId: string, projectId: string) =>
    nexusProxy<{ context: string }>("GET", token, tenantId, projectId, "context"),
  /** Update user persona preferences/expertise */
  updatePersona: (
    token: string,
    tenantId: string,
    projectId: string,
    data: { preferences?: Record<string, unknown>; expertise?: Record<string, string> },
  ) =>
    nexusProxy<{ status: string }>("PATCH", token, tenantId, projectId, "persona", undefined, data),
  /** Record feedback into the flywheel */
  recordFeedback: (
    token: string,
    tenantId: string,
    projectId: string,
    data: {
      event_type: string;
      feedback: Record<string, unknown>;
      agent?: string;
      prompt?: string;
      response_summary?: string;
    },
  ) =>
    nexusProxy<{ status: string }>("POST", token, tenantId, projectId, "feedback", undefined, data),
  /** Get recent agent activity */
  getActivity: (token: string, tenantId: string, projectId: string, limit = 20) =>
    nexusProxy<NexusAgentExecution[]>("GET", token, tenantId, projectId, "activity", { limit: String(limit) }),
};

// --- SSE Stream ---
export function streamBuildEvents(
  token: string,
  tenantId: string,
  projectId: string,
  buildId: string,
  afterSeq = 0,
  onEvent: (event: Record<string, unknown>) => void,
  onEnd: () => void,
  onError: (err: Error) => void
): () => void {
  const url = `${API}/tenants/${tenantId}/projects/${projectId}/builds/${buildId}/events?after_seq=${afterSeq}`;
  let cancelled = false;

  (async () => {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok || !res.body) {
        onError(new Error(`Stream error: ${res.status}`));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.kind === "stream_end") {
                onEnd();
                return;
              }
              onEvent(data);
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
      onEnd();
    } catch (e) {
      if (!cancelled) onError(e instanceof Error ? e : new Error(String(e)));
    }
  })();

  return () => {
    cancelled = true;
  };
}
