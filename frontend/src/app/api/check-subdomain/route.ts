/**
 * @deprecated — Thin proxy to backend FastAPI check-subdomain endpoint.
 * Subdomain availability checking is now handled by the backend at
 * GET /tenants/{tid}/projects/{pid}/check-subdomain?subdomain=...
 */

import { NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function GET(req: NextRequest) {
  const subdomain = req.nextUrl.searchParams.get("subdomain");
  if (!subdomain) {
    return NextResponse.json(
      { error: "subdomain parameter is required" },
      { status: 400 },
    );
  }

  // Client-side format validation (fast rejection before hitting backend)
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(subdomain) && !/^[a-z0-9]$/.test(subdomain)) {
    return NextResponse.json({
      available: false,
      subdomain,
      domain: `${subdomain}.vedaa.io`,
      reason: "Invalid format. Use lowercase letters, numbers, and hyphens only.",
    });
  }

  const token = req.headers.get("authorization") ?? "";
  const tenantId = req.nextUrl.searchParams.get("tenantId");
  const projectId = req.nextUrl.searchParams.get("projectId");

  if (!tenantId || !projectId) {
    return NextResponse.json(
      { error: "tenantId and projectId parameters are required" },
      { status: 400 },
    );
  }

  try {
    const resp = await fetch(
      `${API}/tenants/${tenantId}/projects/${projectId}/check-subdomain?subdomain=${encodeURIComponent(subdomain)}`,
      {
        headers: { Authorization: token },
      },
    );

    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to check availability: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}
