/**
 * Database health check: verifies app_data table exists and RLS allows access.
 * Called by the workspace/preview to diagnose CRUD failures.
 *
 * Uses the service-role key (server-side only) to check table existence,
 * and the anon key + user token to check RLS access.
 */

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const { tenantId, projectId, userToken } = await req.json();

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

  const result: Record<string, unknown> = {
    supabaseUrl: supabaseUrl ? "configured" : "MISSING",
    anonKey: anonKey ? "configured" : "MISSING",
    serviceRoleKey: serviceRoleKey ? "configured" : "MISSING",
    tenantId: tenantId || "MISSING",
    projectId: projectId || "MISSING",
    userToken: userToken ? "present" : "MISSING",
  };

  if (!supabaseUrl || !anonKey) {
    return NextResponse.json({
      ...result,
      status: "error",
      message: "Supabase URL or anon key not configured in environment",
    });
  }

  // Check 1: Does app_data table exist? (use service role to bypass RLS)
  const checkKey = serviceRoleKey || anonKey;
  try {
    const resp = await fetch(`${supabaseUrl}/rest/v1/app_data?select=id&limit=1`, {
      headers: {
        apikey: checkKey,
        Authorization: `Bearer ${checkKey}`,
      },
    });

    if (resp.status === 404 || resp.status === 400) {
      const body = await resp.text();
      if (body.includes("does not exist") || body.includes("not found")) {
        result.tableExists = false;
        result.status = "error";
        result.message =
          "app_data table does not exist. Run: supabase db push (migration 004_app_data_table.sql)";
        return NextResponse.json(result);
      }
    }

    if (resp.ok) {
      result.tableExists = true;
    } else {
      result.tableExists = "unknown";
      result.tableCheckError = await resp.text();
    }
  } catch (e) {
    result.tableExists = "unknown";
    result.tableCheckError = (e as Error).message;
  }

  // Check 2: Does user token pass RLS? (use anon key + user token)
  if (userToken && tenantId) {
    try {
      const resp = await fetch(
        `${supabaseUrl}/rest/v1/app_data?select=id&limit=1&project_id=eq.${projectId}`,
        {
          headers: {
            apikey: anonKey,
            Authorization: `Bearer ${userToken}`,
          },
        }
      );

      if (resp.ok) {
        result.rlsAccess = true;
      } else {
        const body = await resp.text();
        result.rlsAccess = false;
        result.rlsError = body.slice(0, 200);
      }
    } catch (e) {
      result.rlsAccess = "unknown";
      result.rlsError = (e as Error).message;
    }
  } else {
    result.rlsAccess = "skipped — missing userToken or tenantId";
  }

  // Check 3: If service role key available, try to ensure table exists
  if (!result.tableExists && serviceRoleKey) {
    result.autoCreateAttempted = true;
    // Try calling the backend health endpoint to trigger auto-creation
    const backendUrl = process.env.VEDAA_API_URL || process.env.NEXT_PUBLIC_API_URL;
    if (backendUrl) {
      try {
        const resp = await fetch(`${backendUrl}/health`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          result.backendHealth = "reachable — auto-creation may have run";
        }
      } catch {
        result.backendHealth = "unreachable";
      }
    }
  }

  result.status = result.tableExists && result.rlsAccess ? "ok" : "issues_found";
  return NextResponse.json(result);
}
