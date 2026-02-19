/**
 * Neural Nexus proxy route.
 *
 * Routes nexus calls through this same-origin Next.js API route to avoid
 * CORS issues between the Netlify frontend and the Railway backend.
 *
 * Includes retry logic with increasing timeouts to handle Railway cold
 * starts (free-tier services sleep after inactivity and can take 10-30s
 * to wake up).
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getBackendUrl(): string {
  return (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000").replace(
    /\/$/,
    "",
  );
}

function buildNexusUrl(
  backend: string,
  tenantId: string,
  projectId: string,
  action: string,
  searchParams: URLSearchParams,
): string {
  const base = `${backend}/tenants/${tenantId}/projects/${projectId}/nexus`;
  switch (action) {
    case "state":
      return base;
    case "context":
      return `${base}/context`;
    case "persona":
      return `${base}/persona`;
    case "feedback":
      return `${base}/feedback`;
    case "activity": {
      const limit = searchParams.get("limit") ?? "20";
      return `${base}/activity?limit=${limit}`;
    }
    default:
      return base;
  }
}

/**
 * Fetch with timeout + retry for Railway cold starts.
 * Attempt 1: 15s timeout, Attempt 2: 25s timeout (Railway waking up).
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxAttempts = 2,
): Promise<Response> {
  const timeouts = [15_000, 25_000]; // ms per attempt
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeouts[attempt] ?? 25_000,
    );
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastError = err instanceof Error ? err : new Error(String(err));
      // Only retry on network/timeout errors, not on abort by caller
      if (controller.signal.aborted && attempt < maxAttempts - 1) {
        // Timeout — Railway might be waking up, retry
        continue;
      }
      if (
        lastError.message.includes("fetch failed") ||
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("ECONNRESET") ||
        lastError.message.includes("ETIMEDOUT") ||
        lastError.name === "AbortError"
      ) {
        if (attempt < maxAttempts - 1) continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("All retry attempts failed");
}

function errorResponse(backend: string, msg: string, status = 502) {
  return NextResponse.json(
    {
      detail: `Backend unreachable at ${backend}: ${msg}`,
      _backend_url: backend,
      _hint:
        msg.includes("abort") || msg.includes("timeout")
          ? "The Railway service may be sleeping. It can take 10-30s to wake up on the free tier. Try again in a moment."
          : "Check that the Railway service is deployed and running. Visit the Railway dashboard to verify.",
    },
    { status },
  );
}

// ---------------------------------------------------------------------------
// Supabase-direct fallback — reads Nexus state when Railway is unreachable
// ---------------------------------------------------------------------------

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return createClient(url, key);
}

async function getStateDirectFromSupabase(
  tenantId: string,
  projectId: string,
  token: string,
) {
  const db = getServiceClient();
  if (!db) return null;

  // Resolve user from token for persona lookup
  const {
    data: { user },
  } = await db.auth.getUser(token);
  const userId = user?.id;

  // Run all queries in parallel
  const [personaRes, psmRes, blRes, execRes, feedbackRes] = await Promise.all([
    userId
      ? db
          .from("user_persona")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("user_id", userId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    db
      .from("project_state_matrix")
      .select("*")
      .eq("project_id", projectId)
      .maybeSingle(),
    db
      .from("business_logic")
      .select("entity_type, entity_path, entity_name, purpose, domain, confidence")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("agent_executions")
      .select("*")
      .eq("project_id", projectId)
      .order("completed_at", { ascending: false })
      .limit(20),
    db
      .from("nexus_feedback")
      .select("event_type, agent, feedback, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  const persona = personaRes.data;
  const psm = psmRes.data;

  return {
    user_persona: {
      preferences: persona?.preferences ?? {},
      expertise: persona?.expertise ?? {},
      history: persona?.history ?? [],
      stats: {
        total_prompts: persona?.total_prompts ?? 0,
        total_accepted: persona?.total_accepted ?? 0,
        total_rejected: persona?.total_rejected ?? 0,
        acceptance_rate:
          persona?.total_prompts > 0
            ? Math.round(
                ((persona?.total_accepted ?? 0) / persona.total_prompts) * 100,
              )
            : 0,
      },
    },
    project_state: {
      file_graph: psm?.file_graph ?? {},
      dependency_graph: psm?.dependency_graph ?? {},
      tech_debt: psm?.tech_debt ?? [],
      health_score: psm?.health_score ?? 0,
      last_analyzed_at: psm?.last_analyzed_at ?? null,
    },
    business_logic: blRes.data ?? [],
    recent_feedback: feedbackRes.data ?? [],
    agent_activity: execRes.data ?? [],
    _source: "supabase_direct",
  };
}

// ---------------------------------------------------------------------------
// GET — state, context, persona, activity
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const backend = getBackendUrl();
  const sp = req.nextUrl.searchParams;
  const tenantId = sp.get("tenantId");
  const projectId = sp.get("projectId");
  const action = sp.get("action") ?? "state";

  if (!tenantId || !projectId) {
    return NextResponse.json(
      { detail: "tenantId and projectId are required" },
      { status: 400 },
    );
  }

  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  // If backend is localhost (not configured), try Supabase-direct for state
  if (backend.includes("localhost")) {
    if (action === "state") {
      try {
        const fallback = await getStateDirectFromSupabase(tenantId, projectId, token);
        if (fallback) {
          return NextResponse.json(fallback, { status: 200 });
        }
      } catch {
        /* fallback failed */
      }
    }
    return NextResponse.json(
      {
        detail:
          "NEXT_PUBLIC_API_URL is not configured (defaults to localhost). Set it to your Railway backend URL in the Netlify environment variables and redeploy.",
        _backend_url: backend,
      },
      { status: 503 },
    );
  }

  const url = buildNexusUrl(backend, tenantId, projectId, action, sp);

  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";

    // Fallback: read directly from Supabase when backend is unreachable
    if (action === "state") {
      try {
        const fallback = await getStateDirectFromSupabase(
          tenantId!,
          projectId!,
          token!,
        );
        if (fallback) {
          return NextResponse.json(fallback, { status: 200 });
        }
      } catch {
        /* fallback also failed — fall through to error response */
      }
    }

    return errorResponse(backend, msg);
  }
}

// ---------------------------------------------------------------------------
// PATCH — persona update
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest) {
  const backend = getBackendUrl();
  const sp = req.nextUrl.searchParams;
  const tenantId = sp.get("tenantId");
  const projectId = sp.get("projectId");

  if (!tenantId || !projectId) {
    return NextResponse.json(
      { detail: "tenantId and projectId are required" },
      { status: 400 },
    );
  }

  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  const url = buildNexusUrl(backend, tenantId, projectId, "persona", sp);
  const body = await req.json();

  try {
    const res = await fetchWithRetry(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const resBody = await res.text();
    return new NextResponse(resBody, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(backend, msg);
  }
}

// ---------------------------------------------------------------------------
// POST — feedback
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const backend = getBackendUrl();
  const sp = req.nextUrl.searchParams;
  const tenantId = sp.get("tenantId");
  const projectId = sp.get("projectId");

  if (!tenantId || !projectId) {
    return NextResponse.json(
      { detail: "tenantId and projectId are required" },
      { status: 400 },
    );
  }

  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  const url = buildNexusUrl(backend, tenantId, projectId, "feedback", sp);
  const body = await req.json();

  try {
    const res = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const resBody = await res.text();
    return new NextResponse(resBody, {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return errorResponse(backend, msg);
  }
}
