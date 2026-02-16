/**
 * Health check endpoint to verify environment variables and API connectivity.
 * Visit /api/health in your browser to diagnose deployment issues.
 */

import { NextResponse } from "next/server";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  // 1. Check ANTHROPIC_API_KEY
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    checks.ANTHROPIC_API_KEY = {
      ok: false,
      detail: "NOT SET — add it in Netlify > Site settings > Environment variables",
    };
  } else if (apiKey.length < 10) {
    checks.ANTHROPIC_API_KEY = {
      ok: false,
      detail: `Set but looks invalid (length: ${apiKey.length})`,
    };
  } else {
    checks.ANTHROPIC_API_KEY = {
      ok: true,
      detail: `Set (${apiKey.slice(0, 7)}...${apiKey.slice(-4)})`,
    };
  }

  // 2. Check NEXT_PUBLIC vars
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
      detail: "NOT SET — required for Publish. Set at Site level (Site settings > Environment variables), NOT team-level.",
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

  const nfTeamSlug = process.env.NF_TEAM_SLUG;
  checks.NF_TEAM_SLUG = {
    ok: !!nfTeamSlug,
    detail: nfTeamSlug || 'NOT SET (will default to "devos")',
  };

  const nfSitePrefix = process.env.NF_SITE_PREFIX;
  checks.NF_SITE_PREFIX = {
    ok: !!nfSitePrefix,
    detail: nfSitePrefix || 'NOT SET (will default to "devos")',
  };

  const nfCustomDomain = process.env.NF_CUSTOM_DOMAIN;
  checks.NF_CUSTOM_DOMAIN = {
    ok: true, // optional
    detail: nfCustomDomain || "NOT SET (no custom domain for published apps)",
  };

  // 4. Check DEEPSEEK_API_KEY (Swarm analyzer)
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  if (!deepseekKey) {
    checks.DEEPSEEK_API_KEY = {
      ok: false,
      detail: "NOT SET — required for AI Swarm analyzer. Set at Site level (Site settings > Environment variables).",
    };
  } else if (deepseekKey.length < 10) {
    checks.DEEPSEEK_API_KEY = {
      ok: false,
      detail: `Set but looks invalid (length: ${deepseekKey.length})`,
    };
  } else {
    checks.DEEPSEEK_API_KEY = {
      ok: true,
      detail: `Set (${deepseekKey.slice(0, 6)}...${deepseekKey.slice(-4)})`,
    };
  }

  // 5. Test Anthropic API connectivity (quick, non-streaming)
  if (apiKey) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });

      if (res.ok) {
        checks.ANTHROPIC_API_CONNECTIVITY = {
          ok: true,
          detail: "Successfully connected to Anthropic API",
        };
      } else {
        const body = await res.text();
        let msg = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(body);
          msg = parsed.error?.message || msg;
        } catch {
          // use default
        }
        checks.ANTHROPIC_API_CONNECTIVITY = {
          ok: false,
          detail: `API returned error: ${msg}`,
        };
      }
    } catch (err) {
      checks.ANTHROPIC_API_CONNECTIVITY = {
        ok: false,
        detail: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }
  }

  const allOk = Object.values(checks).every((c) => c.ok);

  return NextResponse.json(
    {
      status: allOk ? "healthy" : "unhealthy",
      timestamp: new Date().toISOString(),
      checks,
    },
    { status: allOk ? 200 : 503 }
  );
}
