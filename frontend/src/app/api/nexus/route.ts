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
// GET — state, context, persona, activity
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const backend = getBackendUrl();

  if (backend.includes("localhost")) {
    return NextResponse.json(
      {
        detail:
          "NEXT_PUBLIC_API_URL is not configured (defaults to localhost). Set it to your Railway backend URL in the Netlify environment variables and redeploy.",
        _backend_url: backend,
      },
      { status: 503 },
    );
  }

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
