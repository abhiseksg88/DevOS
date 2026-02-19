/**
 * Health check endpoint to verify environment variables and API connectivity.
 * Visit /api/health in your browser to diagnose deployment issues.
 *
 * Note: LLM API keys (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY) are no longer checked
 * here — model-provider calls are handled by the backend FastAPI service.
 */

import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // 1. Check NEXT_PUBLIC vars (Supabase)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  checks.NEXT_PUBLIC_SUPABASE_URL = {
    ok: !!supabaseUrl,
    detail: supabaseUrl || "NOT SET",
  };

  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  checks.NEXT_PUBLIC_SUPABASE_ANON_KEY = {
    ok: !!supabaseKey,
    detail: supabaseKey
      ? `Set (${supabaseKey.slice(0, 10)}...)`
      : "NOT SET",
  };

  // 2. Check backend API URL
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  checks.NEXT_PUBLIC_API_URL = {
    ok: !!apiUrl,
    detail: apiUrl || "NOT SET (will default to http://localhost:8000)",
  };

  // 3. Check NF_* vars (Netlify publish)
  const nfToken = process.env.NF_TOKEN;
  if (!nfToken) {
    checks.NF_TOKEN = {
      ok: false,
      detail: "NOT SET — required for Publish. Set at Site level (Site settings > Environment variables).",
    };
  } else if (nfToken.length < 10) {
    checks.NF_TOKEN = {
      ok: false,
      detail: `Set but looks invalid (length: ${nfToken.length})`,
    };
  } else {
    checks.NF_TOKEN = {
      ok: true,
      detail: `Set (${nfToken.slice(0, 6)}...${nfToken.slice(-4)})`,
    };
  }

  const nfCustomDomain = process.env.NF_CUSTOM_DOMAIN;
  checks.NF_CUSTOM_DOMAIN = {
    ok: true, // optional
    detail: nfCustomDomain || "NOT SET (no custom domain for published apps)",
  };

  // 4. Test backend API connectivity
  const backendUrl = apiUrl || "http://localhost:8000";
  try {
    const res = await fetch(`${backendUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      checks.BACKEND_API = {
        ok: true,
        detail: `Connected — ${data.status || "ok"}`,
      };
    } else {
      checks.BACKEND_API = {
        ok: false,
        detail: `Backend returned HTTP ${res.status}`,
      };
    }
  } catch (err) {
    checks.BACKEND_API = {
      ok: false,
      detail: `Backend unreachable: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // 5. Test backend publish readiness
  try {
    const res = await fetch(`${backendUrl}/health/publish`, {
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const data = await res.json();
      checks.PUBLISH_READY = {
        ok: data.ready ?? false,
        detail: data.ready
          ? `Ready — Netlify team: ${data.netlify_team || "default"}`
          : `Not ready: ${data.netlify_error || "check backend config"}`,
      };
    } else {
      checks.PUBLISH_READY = {
        ok: false,
        detail: `Backend publish health returned HTTP ${res.status}`,
      };
    }
  } catch {
    checks.PUBLISH_READY = {
      ok: false,
      detail: "Could not check publish readiness (backend unreachable)",
    };
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 },
  );
}
