/**
 * Vedaa.io API client.
 * All calls go through the FastAPI backend.
 */

import type { Build, Deployment, Project, PublishResult, PublishStatus, Tenant, UsageSummary } from "@/types";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function request<T>(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
export const publish = {
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
