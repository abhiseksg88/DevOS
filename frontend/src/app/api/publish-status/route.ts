/**
 * @deprecated — Thin proxy to backend FastAPI publish-status endpoint.
 * Deploy status polling is now handled by the backend at
 * GET /tenants/{tid}/projects/{pid}/publish-status?deploy_id=...
 */

import { NextRequest, NextResponse } from "next/server";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function GET(req: NextRequest) {
  const deployId = req.nextUrl.searchParams.get("deploy_id");
  if (!deployId) {
    return NextResponse.json({ error: "deploy_id is required" }, { status: 400 });
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
      `${API}/tenants/${tenantId}/projects/${projectId}/publish-status?deploy_id=${encodeURIComponent(deployId)}`,
      {
        headers: { Authorization: token },
      },
    );

    const data = await resp.json();
    return NextResponse.json(data, { status: resp.status });
  } catch (err) {
    return NextResponse.json(
      {
        error: `Failed to check status: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}
