/**
 * Check subdomain availability under vedaa.io.
 * Queries the projects table for any project already using this subdomain.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: NextRequest) {
  const subdomain = req.nextUrl.searchParams.get("subdomain");
  if (!subdomain) {
    return NextResponse.json(
      { error: "subdomain parameter is required" },
      { status: 400 }
    );
  }

  // Validate format: lowercase alphanumeric + hyphens, 1-40 chars
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(subdomain) && !/^[a-z0-9]$/.test(subdomain)) {
    return NextResponse.json({
      available: false,
      reason: "Invalid format. Use lowercase letters, numbers, and hyphens only.",
    });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const customDomainBase = process.env.NF_CUSTOM_DOMAIN || "vedaa.io";

  const key = supabaseServiceKey || supabaseAnonKey;
  if (!supabaseUrl || !key) {
    return NextResponse.json(
      { error: "Database not configured" },
      { status: 500 }
    );
  }

  const supabase = createClient(supabaseUrl, key);
  const fullDomain = `${subdomain}.${customDomainBase}`;

  try {
    // Check if any project already uses this custom_domain
    const { data, error } = await supabase
      .from("projects")
      .select("id, custom_domain")
      .eq("custom_domain", fullDomain)
      .limit(1);

    if (error) {
      console.error("[check-subdomain] DB error:", error);
      return NextResponse.json(
        { error: "Failed to check availability" },
        { status: 500 }
      );
    }

    const taken = data && data.length > 0;

    return NextResponse.json({
      available: !taken,
      subdomain,
      domain: fullDomain,
      reason: taken ? "This subdomain is already in use." : undefined,
    });
  } catch (err) {
    console.error("[check-subdomain] Error:", err);
    return NextResponse.json(
      { error: "Failed to check availability" },
      { status: 500 }
    );
  }
}
