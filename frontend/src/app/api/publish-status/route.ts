/**
 * Publish status polling route — checks Netlify deploy status.
 */

import { NextRequest, NextResponse } from "next/server";

const NETLIFY_API = "https://api.netlify.com/api/v1";

export async function GET(req: NextRequest) {
  const deployId = req.nextUrl.searchParams.get("deploy_id");
  if (!deployId) {
    return NextResponse.json({ error: "deploy_id is required" }, { status: 400 });
  }

  const netlifyToken = process.env.NF_TOKEN;
  if (!netlifyToken) {
    return NextResponse.json({ error: "NF_TOKEN not configured" }, { status: 503 });
  }

  try {
    const resp = await fetch(`${NETLIFY_API}/deploys/${deployId}`, {
      headers: { Authorization: `Bearer ${netlifyToken}` },
    });

    if (!resp.ok) {
      return NextResponse.json(
        { error: `Netlify API error: ${resp.status}` },
        { status: 502 }
      );
    }

    const data = await resp.json();
    return NextResponse.json({
      state: data.state || "unknown",
      url: data.ssl_url || data.url || "",
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to check status: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}
