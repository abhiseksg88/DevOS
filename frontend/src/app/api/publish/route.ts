/**
 * Publish API route — deploys generated apps to Netlify.
 *
 * Ported from nimbusforge/services/netlify.py to run as a Next.js
 * serverless function on Netlify. Uses the Netlify file-digest API
 * to deploy a self-contained index.html.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHash, randomBytes } from "crypto";
import { createClient } from "@supabase/supabase-js";

const NETLIFY_API = "https://api.netlify.com/api/v1";

function netlifyHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

export async function POST(req: NextRequest) {
  // --- Parse body ---
  let body: {
    html: string;
    projectId: string;
    projectSlug: string;
    projectName: string;
    tenantId: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { html, projectId, projectSlug, projectName, tenantId } = body;
  if (!html || !projectId || !projectSlug) {
    return NextResponse.json(
      { error: "html, projectId, and projectSlug are required" },
      { status: 400 }
    );
  }

  // --- Env vars ---
  const netlifyToken = process.env.NF_TOKEN;
  if (!netlifyToken) {
    return NextResponse.json(
      { error: "NF_TOKEN is not configured. Add it to your Netlify environment variables." },
      { status: 503 }
    );
  }

  const teamSlug = process.env.NF_TEAM_SLUG || "devos";
  const sitePrefix = process.env.NF_SITE_PREFIX || "devos";
  const customDomainBase = process.env.NF_CUSTOM_DOMAIN || "";

  // --- Supabase client (using user's token for RLS) ---
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const authHeader = req.headers.get("authorization");
  const userToken = authHeader?.replace("Bearer ", "");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let supabase: any = null;
  if (supabaseUrl && supabaseAnonKey && userToken) {
    supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: `Bearer ${userToken}` } },
    });
  }

  // --- Step 1: Get or create Netlify site ---
  let siteId: string | null = null;

  // Try to get existing site_id from project
  if (supabase) {
    try {
      const { data: project } = await supabase
        .from("projects")
        .select("netlify_site_id")
        .eq("id", projectId)
        .single();
      siteId = project?.netlify_site_id || null;
    } catch {
      // Continue without existing site
    }
  }

  if (!siteId) {
    // Create a new Netlify site
    let siteName = `${sitePrefix}-${projectSlug}`;
    const headers = netlifyHeaders(netlifyToken);

    let resp = await fetch(`${NETLIFY_API}/${teamSlug}/sites`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: siteName }),
    });

    // 422 = name taken, append random suffix
    if (resp.status === 422) {
      siteName = `${siteName}-${randomBytes(3).toString("hex")}`;
      resp = await fetch(`${NETLIFY_API}/${teamSlug}/sites`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: siteName }),
      });
    }

    if (!resp.ok) {
      const err = await resp.text();
      return NextResponse.json(
        { error: `Failed to create Netlify site: ${err}` },
        { status: 502 }
      );
    }

    const siteData = await resp.json();
    siteId = siteData.id;

    // Save site_id to project
    if (supabase) {
      await supabase
        .from("projects")
        .update({ netlify_site_id: siteId, deployment_status: "deploying" })
        .eq("id", projectId);
    }
  }

  // --- Step 2: Deploy HTML via file digest ---
  const htmlBytes = Buffer.from(html, "utf-8");
  const sha1 = createHash("sha1").update(htmlBytes).digest("hex");
  const headers = netlifyHeaders(netlifyToken);

  let deployId: string;
  let deployUrl: string;

  // Retry up to 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Create deploy with digest
      const digestResp = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
        method: "POST",
        headers,
        body: JSON.stringify({ files: { "/index.html": sha1 } }),
      });

      if (!digestResp.ok) {
        throw new Error(`Deploy digest failed: ${digestResp.status}`);
      }

      const deploy = await digestResp.json();
      deployId = deploy.id;
      deployUrl = deploy.ssl_url || deploy.url || "";

      // Upload file if needed
      const required: string[] = deploy.required || [];
      if (required.includes(sha1)) {
        const uploadResp = await fetch(
          `${NETLIFY_API}/deploys/${deployId}/files/index.html`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${netlifyToken}`,
              "Content-Type": "application/octet-stream",
            },
            body: htmlBytes,
          }
        );

        if (!uploadResp.ok) {
          throw new Error(`File upload failed: ${uploadResp.status}`);
        }
      }

      break; // Success
    } catch (err) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      return NextResponse.json(
        { error: `Deploy failed after 3 attempts: ${err instanceof Error ? err.message : String(err)}` },
        { status: 502 }
      );
    }
  }

  // --- Step 3: Wait for deploy to be ready (max 30s) ---
  let finalStatus = "deploying";
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));

    const statusResp = await fetch(`${NETLIFY_API}/deploys/${deployId!}`, {
      headers: { Authorization: `Bearer ${netlifyToken}` },
    });

    if (statusResp.ok) {
      const statusData = await statusResp.json();
      if (statusData.state === "ready") {
        finalStatus = "ready";
        deployUrl = statusData.ssl_url || statusData.url || deployUrl!;
        break;
      }
      if (statusData.state === "error" || statusData.state === "failed") {
        return NextResponse.json(
          { error: "Deploy failed on Netlify" },
          { status: 502 }
        );
      }
    }
  }

  // --- Step 4: Add custom domain ---
  let customDomain: string | null = null;
  if (customDomainBase && siteId) {
    customDomain = `${projectSlug}.${customDomainBase}`;
    try {
      await fetch(`${NETLIFY_API}/sites/${siteId}/domains`, {
        method: "POST",
        headers,
        body: JSON.stringify({ domain_name: customDomain }),
      });
      // If custom domain works, use it as primary URL
      deployUrl = `https://${customDomain}`;
    } catch {
      // Custom domain failed — fall back to default URL
      customDomain = null;
    }
  }

  // --- Step 5: Update project in Supabase ---
  if (supabase) {
    try {
      await supabase
        .from("projects")
        .update({
          deployed_url: deployUrl!,
          deployed_at: new Date().toISOString(),
          deployment_status: finalStatus === "ready" ? "deployed" : "deploying",
          custom_domain: customDomain,
        })
        .eq("id", projectId);

      // Insert deployment record
      await supabase.from("netlify_deployments").insert({
        tenant_id: tenantId,
        project_id: projectId,
        netlify_site_id: siteId,
        netlify_deploy_id: deployId!,
        status: finalStatus === "ready" ? "ready" : "pending",
        url: deployUrl!,
      });
    } catch {
      // Non-fatal — deploy succeeded even if DB update fails
    }
  }

  return NextResponse.json({
    deploy_id: deployId!,
    url: deployUrl!,
    status: finalStatus,
    netlify_site_id: siteId,
    custom_domain: customDomain,
  });
}
