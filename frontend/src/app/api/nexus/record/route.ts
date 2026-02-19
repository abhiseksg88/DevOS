/**
 * Neural Nexus Recording Endpoint
 *
 * Writes generation telemetry directly to Supabase Nexus tables
 * using the service-role key. This bypasses the Railway backend,
 * so the Nexus panel is populated even when Railway is sleeping.
 *
 * Called fire-and-forget by useGenerate after each successful build.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

interface PipelineStage {
  id: string;
  agent: string;
  model: string;
  status: string;
  message: string;
  meta?: {
    tokens_in?: number;
    tokens_out?: number;
    cost_usd?: number;
    latency_ms?: number;
  };
}

interface RecordPayload {
  projectId: string;
  prompt: string;
  files: { path: string; content: string }[];
  pipelineEvents: PipelineStage[];
  prd?: Record<string, unknown>;
}

const AGENT_STEP_MAP: Record<string, string> = {
  analyzer: "plan",
  coder: "generate_code",
  reviewer: "security_audit",
  fixer: "generate_code",
};

const MODEL_TIER_MAP: Record<string, string> = {
  deepseek: "deepseek",
  "claude-sonnet": "sonnet",
  "claude-haiku": "haiku",
};

export async function POST(req: NextRequest) {
  const db = getServiceClient();
  if (!db) {
    return NextResponse.json(
      { error: "Service role key not configured" },
      { status: 500 },
    );
  }

  // Authenticate the caller
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const {
    data: { user },
  } = await db.auth.getUser(token);
  if (!user) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let payload: RecordPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { projectId, prompt, files, pipelineEvents } = payload;
  if (!projectId) {
    return NextResponse.json(
      { error: "projectId is required" },
      { status: 400 },
    );
  }

  // Look up tenant_id from the project
  const { data: project } = await db
    .from("projects")
    .select("tenant_id")
    .eq("id", projectId)
    .single();

  if (!project?.tenant_id) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const tenantId = project.tenant_id;
  const userId = user.id;
  const errors: string[] = [];

  // 1. Upsert user_persona — increment total_prompts & total_accepted
  try {
    const { data: existing } = await db
      .from("user_persona")
      .select("id, total_prompts, total_accepted")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .single();

    if (existing) {
      await db
        .from("user_persona")
        .update({
          total_prompts: (existing.total_prompts || 0) + 1,
          total_accepted: (existing.total_accepted || 0) + 1,
        })
        .eq("id", existing.id);
    } else {
      await db.from("user_persona").insert({
        tenant_id: tenantId,
        user_id: userId,
        total_prompts: 1,
        total_accepted: 1,
        preferences: {},
        expertise: {},
        history: [],
      });
    }
  } catch (e) {
    errors.push(`user_persona: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2. Upsert project_state_matrix — update file_graph
  if (files && files.length > 0) {
    try {
      const fileGraph: Record<
        string,
        { type: string; lines: number; complexity: string }
      > = {};
      for (const f of files) {
        const lines = f.content.split("\n").length;
        const isComponent =
          f.content.includes("export default function") ||
          f.content.includes("export default class");
        fileGraph[f.path] = {
          type: isComponent ? "react_component" : "module",
          lines,
          complexity: lines > 200 ? "high" : lines > 100 ? "medium" : "low",
        };
      }

      const { data: existingPsm } = await db
        .from("project_state_matrix")
        .select("id")
        .eq("project_id", projectId)
        .single();

      if (existingPsm) {
        await db
          .from("project_state_matrix")
          .update({
            file_graph: fileGraph,
            last_analyzed_at: new Date().toISOString(),
          })
          .eq("id", existingPsm.id);
      } else {
        await db.from("project_state_matrix").insert({
          tenant_id: tenantId,
          project_id: projectId,
          file_graph: fileGraph,
          last_analyzed_at: new Date().toISOString(),
        });
      }
    } catch (e) {
      errors.push(
        `project_state_matrix: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 3. Insert agent_executions — one per pipeline stage
  if (pipelineEvents && pipelineEvents.length > 0) {
    try {
      const executions = pipelineEvents
        .filter((ev) => ev.status === "completed" || ev.status === "failed")
        .map((ev) => ({
          tenant_id: tenantId,
          project_id: projectId,
          agent_role: ev.agent === "coder" || ev.agent === "fixer"
            ? "principal_builder"
            : ev.agent === "analyzer"
              ? "shadow_cto"
              : ev.agent === "reviewer"
                ? "red_team_sentinel"
                : ev.agent,
          agent_step: AGENT_STEP_MAP[ev.agent] || ev.agent,
          model_tier: MODEL_TIER_MAP[ev.model] || ev.model,
          model_id: ev.model,
          input_summary: prompt?.substring(0, 200),
          output_summary: ev.message,
          tokens_in: ev.meta?.tokens_in || 0,
          tokens_out: ev.meta?.tokens_out || 0,
          cost_usd: ev.meta?.cost_usd || 0,
          latency_ms: ev.meta?.latency_ms || 0,
          status: ev.status === "completed" ? "succeeded" : "failed",
          completed_at: new Date().toISOString(),
        }));

      if (executions.length > 0) {
        await db.from("agent_executions").insert(executions);
      }
    } catch (e) {
      errors.push(
        `agent_executions: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // 4. Insert nexus_feedback — record the generation event
  try {
    await db.from("nexus_feedback").insert({
      tenant_id: tenantId,
      project_id: projectId,
      user_id: userId,
      event_type: "code_accepted",
      agent: "principal_builder",
      prompt: prompt?.substring(0, 500),
      response_summary: `Generated ${files?.length || 0} files`,
      feedback: {
        files_changed: files?.map((f) => f.path) || [],
        pipeline_stages: pipelineEvents?.length || 0,
      },
    });
  } catch (e) {
    errors.push(
      `nexus_feedback: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  // 5. Upsert business_logic — extract entities from files and PRD
  try {
    const logicEntries: Array<{
      tenant_id: string;
      project_id: string;
      entity_type: string;
      entity_path: string;
      entity_name: string;
      purpose: string;
      domain: string | null;
      confidence: number;
      source: string;
    }> = [];

    // Extract from generated files
    if (files && files.length > 0) {
      for (const f of files) {
        // React components: export default function ComponentName
        const compMatch = f.content.match(
          /export\s+default\s+function\s+(\w+)/,
        );
        if (compMatch) {
          logicEntries.push({
            tenant_id: tenantId,
            project_id: projectId,
            entity_type: "component",
            entity_path: f.path,
            entity_name: compMatch[1],
            purpose: `React component in ${f.path}`,
            domain: "ui",
            confidence: 0.85,
            source: "code_analysis",
          });
        }

        // Custom hooks: export function useXxx
        const hookMatches = f.content.matchAll(
          /export\s+(?:default\s+)?function\s+(use\w+)/g,
        );
        for (const hm of hookMatches) {
          logicEntries.push({
            tenant_id: tenantId,
            project_id: projectId,
            entity_type: "hook",
            entity_path: f.path,
            entity_name: hm[1],
            purpose: `Custom hook in ${f.path}`,
            domain: "logic",
            confidence: 0.85,
            source: "code_analysis",
          });
        }
      }
    }

    // Extract from PRD if provided
    const prd = payload.prd;
    if (prd) {
      const newComponents = (prd.new_components as Array<{
        name: string;
        description: string;
      }>) || [];
      for (const comp of newComponents) {
        logicEntries.push({
          tenant_id: tenantId,
          project_id: projectId,
          entity_type: "component",
          entity_path: `prd/${comp.name}`,
          entity_name: comp.name,
          purpose: comp.description || `Planned component: ${comp.name}`,
          domain: "ui",
          confidence: 0.9,
          source: "planner_prd",
        });
      }

      const dataModel = prd.data_model as
        | Record<string, { fields?: string[] }>
        | undefined;
      if (dataModel) {
        for (const [name, def] of Object.entries(dataModel)) {
          logicEntries.push({
            tenant_id: tenantId,
            project_id: projectId,
            entity_type: "collection",
            entity_path: `data/${name}`,
            entity_name: name,
            purpose: `Collection with fields: ${def.fields?.join(", ") || "flexible"}`,
            domain: "data",
            confidence: 0.9,
            source: "planner_prd",
          });
        }
      }
    }

    if (logicEntries.length > 0) {
      await db.from("business_logic").upsert(logicEntries, {
        onConflict: "project_id,entity_type,entity_path",
      });
    }
  } catch (e) {
    errors.push(
      `business_logic: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return NextResponse.json({
    recorded: true,
    errors: errors.length > 0 ? errors : undefined,
  });
}
