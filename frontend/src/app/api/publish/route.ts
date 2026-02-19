/**
 * @deprecated — Thin proxy to backend FastAPI publish endpoint.
 * All Netlify orchestration, domain mapping, and DB writes are now handled
 * by the backend at POST /tenants/{tid}/projects/{pid}/publish.
 */

import { NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function POST(req: NextRequest) {
  let body: {
    html: string;
    projectId: string;
    projectSlug: string;
    projectName: string;
    tenantId: string;
    customSubdomain?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { html, projectId, tenantId, customSubdomain } = body;
  if (!html || !projectId || !tenantId) {
    return NextResponse.json(
      { error: "html, projectId, and tenantId are required" },
      { status: 400 },
    );
  }

  const token = req.headers.get("authorization") ?? "";

  try {
    const resp = await fetch(
      `${API}/tenants/${tenantId}/projects/${projectId}/publish`,
      {
        method: "POST",
        headers: {
          Authorization: token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          html,
          custom_subdomain: customSubdomain || undefined,
        }),
      },
    );

    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Backend publish failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}
