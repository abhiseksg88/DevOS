/**
 * Neural Nexus proxy route.
 *
 * The Neural Nexus panel talks to the FastAPI backend on Railway. Browser
 * requests from the Netlify-hosted frontend are blocked by CORS because the
 * Railway origin differs from the Netlify origin.
 *
 * This server-side proxy eliminates the CORS issue: the browser calls this
 * same-origin Next.js route, which forwards the request to the Railway
 * backend server-to-server (no CORS restrictions).
 */

import { NextRequest, NextResponse } from "next/server";

const BACKEND =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function backendUrl(
  tenantId: string,
  projectId: string,
  action: string,
  searchParams: URLSearchParams,
): string {
  const base = `${BACKEND}/tenants/${tenantId}/projects/${projectId}/nexus`;
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

/** GET — state, context, persona, activity */
export async function GET(req: NextRequest) {
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

  const url = backendUrl(tenantId, projectId, action, sp);

  try {
    const res = await fetch(url, {
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
    return NextResponse.json(
      {
        detail: `Backend unreachable at ${BACKEND}: ${msg}`,
        _backend_url: BACKEND,
      },
      { status: 502 },
    );
  }
}

/** PATCH — persona update */
export async function PATCH(req: NextRequest) {
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

  const url = backendUrl(tenantId, projectId, "persona", sp);
  const body = await req.json();

  try {
    const res = await fetch(url, {
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
    return NextResponse.json(
      { detail: `Backend unreachable: ${msg}` },
      { status: 502 },
    );
  }
}

/** POST — feedback */
export async function POST(req: NextRequest) {
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

  const url = backendUrl(tenantId, projectId, "feedback", sp);
  const body = await req.json();

  try {
    const res = await fetch(url, {
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
    return NextResponse.json(
      { detail: `Backend unreachable: ${msg}` },
      { status: 502 },
    );
  }
}
