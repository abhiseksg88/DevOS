/**
 * Proxy endpoint for Supabase credentials.
 * Calls the backend /preview/credentials endpoint.
 */

import { NextResponse } from "next/server";

const BACKEND_API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export async function GET(request: Request) {
  try {
    // Get auth token from request headers (if available)
    const authHeader = request.headers.get("authorization");

    // Call backend
    const response = await fetch(`${BACKEND_API}/preview/credentials`, {
      headers: authHeader ? { Authorization: authHeader } : {},
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to fetch credentials" },
        { status: response.status }
      );
    }

    const credentials = await response.json();
    return NextResponse.json(credentials);
  } catch (error) {
    console.error("[preview-credentials] Error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
