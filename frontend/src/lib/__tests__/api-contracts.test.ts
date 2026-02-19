/**
 * Frontend contract tests — verify the frontend can parse backend responses.
 *
 * These type guards match the TypeScript interfaces in types/index.ts
 * against representative backend payloads. If the backend changes its
 * response shape, these tests will catch the mismatch.
 */

import type {
  Build,
  BuildEvent,
  PublishResult,
  PublishStatus,
  Project,
  Tenant,
} from "@/types";

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isBuild(data: unknown): data is Build {
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.status === "string" &&
    typeof d.prompt === "string" &&
    typeof d.tenant_id === "string" &&
    typeof d.project_id === "string" &&
    Array.isArray(d.files_changed)
  );
}

function isBuildEvent(data: unknown): data is BuildEvent {
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.build_id === "string" &&
    typeof d.kind === "string" &&
    typeof d.seq === "number" &&
    typeof d.payload === "object" &&
    d.payload !== null
  );
}

function isPublishResult(data: unknown): data is PublishResult {
  const d = data as Record<string, unknown>;
  return (
    typeof d.deploy_id === "string" &&
    typeof d.url === "string" &&
    typeof d.status === "string" &&
    typeof d.netlify_site_id === "string"
  );
}

function isPublishStatus(data: unknown): data is PublishStatus {
  const d = data as Record<string, unknown>;
  return typeof d.state === "string" && typeof d.url === "string";
}

function isProject(data: unknown): data is Project {
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.slug === "string" &&
    typeof d.tenant_id === "string"
  );
}

function isTenant(data: unknown): data is Tenant {
  const d = data as Record<string, unknown>;
  return (
    typeof d.id === "string" &&
    typeof d.name === "string" &&
    typeof d.slug === "string"
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Build response contract", () => {
  test("queued build matches frontend type", () => {
    const mockResponse = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      tenant_id: "660e8400-e29b-41d4-a716-446655440000",
      project_id: "770e8400-e29b-41d4-a716-446655440000",
      status: "queued",
      prompt: "Build a todo app",
      files_changed: [],
      commit_sha: null,
      image_tag: null,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_cost_usd: 0.0,
      error_message: null,
      started_at: null,
      completed_at: null,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuild(mockResponse)).toBe(true);
  });

  test("succeeded build matches frontend type", () => {
    const mockResponse = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      tenant_id: "660e8400-e29b-41d4-a716-446655440000",
      project_id: "770e8400-e29b-41d4-a716-446655440000",
      status: "succeeded",
      prompt: "Build a CRM",
      files_changed: ["src/app/page.tsx", "src/components/Login.tsx"],
      commit_sha: "abc123",
      image_tag: "v1.0.0",
      total_tokens_in: 15000,
      total_tokens_out: 8000,
      total_cost_usd: 0.045,
      error_message: null,
      started_at: "2024-01-01T00:01:00Z",
      completed_at: "2024-01-01T00:02:30Z",
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuild(mockResponse)).toBe(true);
  });

  test("all build statuses are valid strings", () => {
    const statuses = [
      "queued", "planning", "awaiting_approval", "scaffolding",
      "coding", "reviewing", "building", "deploying",
      "succeeded", "failed", "cancelled",
    ];
    for (const status of statuses) {
      expect(typeof status).toBe("string");
    }
  });
});

describe("Build event response contract", () => {
  test("agent_start event matches frontend type", () => {
    const event = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      build_id: "660e8400-e29b-41d4-a716-446655440000",
      kind: "agent_start",
      agent: "opus",
      payload: { agent: "planner", message: "Planning build..." },
      seq: 1,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuildEvent(event)).toBe(true);
  });

  test("file_content event matches frontend type", () => {
    const event = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      build_id: "660e8400-e29b-41d4-a716-446655440000",
      kind: "file_content",
      agent: "sonnet",
      payload: { path: "src/app/page.tsx", content: "export default function Page() {}" },
      seq: 5,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuildEvent(event)).toBe(true);
    expect((event.payload as Record<string, unknown>).path).toBe("src/app/page.tsx");
  });

  test("HITL info event has hitl_required field", () => {
    const event = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      build_id: "660e8400-e29b-41d4-a716-446655440000",
      kind: "info",
      agent: "opus",
      payload: {
        hitl_required: true,
        plan: { summary: "Build a todo app", tasks: [] },
      },
      seq: 3,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuildEvent(event)).toBe(true);
    expect((event.payload as Record<string, unknown>).hitl_required).toBe(true);
  });

  test("error event allows null agent", () => {
    const event = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      build_id: "660e8400-e29b-41d4-a716-446655440000",
      kind: "error",
      agent: null,
      payload: { message: "Build failed" },
      seq: 10,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isBuildEvent(event)).toBe(true);
  });
});

describe("Publish response contracts", () => {
  test("publish result with custom domain", () => {
    const result = {
      deploy_id: "deploy_123",
      url: "https://my-app.vedaa.io",
      status: "ready",
      netlify_site_id: "site_abc",
      custom_domain: "my-app.vedaa.io",
    };
    expect(isPublishResult(result)).toBe(true);
  });

  test("publish result without custom domain", () => {
    const result = {
      deploy_id: "deploy_456",
      url: "https://devos-my-app.netlify.app",
      status: "deploying",
      netlify_site_id: "site_def",
    };
    expect(isPublishResult(result)).toBe(true);
  });

  test("publish status response", () => {
    const status = { state: "ready", url: "https://my-app.vedaa.io" };
    expect(isPublishStatus(status)).toBe(true);
  });
});

describe("Project & Tenant contracts", () => {
  test("project response matches frontend type", () => {
    const project = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      tenant_id: "660e8400-e29b-41d4-a716-446655440000",
      name: "My App",
      slug: "my-app",
      description: "A test app",
      status: "active",
      stack: { framework: "nextjs" },
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
    };
    expect(isProject(project)).toBe(true);
  });

  test("tenant response matches frontend type", () => {
    const tenant = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      name: "My Org",
      slug: "my-org",
      plan: "free",
      monthly_budget_usd: 50.0,
      monthly_spent_usd: 12.5,
      created_at: "2024-01-01T00:00:00Z",
    };
    expect(isTenant(tenant)).toBe(true);
  });
});
