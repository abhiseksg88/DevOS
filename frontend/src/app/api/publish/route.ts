/**
 * Publish API route — marks a project as published and optionally deploys to Netlify.
 *
 * Published apps are served via subdomain routing:
 *   {slug}.vedaa.io → middleware → /api/serve-app?slug={slug} → HTML from Supabase
 *
 * The Netlify deploy is kept as a backup/CDN fallback, but the primary URL
 * is the subdomain URL which is served by the main app's middleware.
 *
 * NOTE: We do NOT try to add custom domains to separate Netlify sites because
 * the *.vedaa.io wildcard DNS is claimed by the main site. Instead, subdomain
 * routing in middleware.ts handles serving published apps.
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

  // --- Determine the primary published URL ---
  // The subdomain URL is the primary URL (served by our middleware)
  const customDomain = customDomainBase ? `${projectSlug}.${customDomainBase}` : null;
  const primaryUrl = customDomain
    ? `https://${customDomain}`
    : `https://vedaa.io/p/${projectSlug}`; // Fallback to path-based URL

  // --- Optional: Deploy to Netlify as a CDN backup ---
  let netlifyDeployId: string | null = null;
  let netlifySiteId: string | null = null;
  let netlifyUrl: string | null = null;

  if (netlifyToken) {
    try {
      // Get or create Netlify site
      let siteId: string | null = null;

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
        let siteName = `${sitePrefix}-${projectSlug}`;
        const nfHeaders = netlifyHeaders(netlifyToken);

        let resp = await fetch(`${NETLIFY_API}/sites`, {
          method: "POST",
          headers: nfHeaders,
          body: JSON.stringify({ name: siteName }),
        });

        if (resp.status === 422) {
          siteName = `${siteName}-${randomBytes(3).toString("hex")}`;
          resp = await fetch(`${NETLIFY_API}/sites`, {
            method: "POST",
            headers: nfHeaders,
            body: JSON.stringify({ name: siteName }),
          });
        }

        if (resp.ok) {
          const siteData = await resp.json();
          siteId = siteData.id;
        }
      }

      if (siteId) {
        netlifySiteId = siteId;

        // Deploy HTML via file digest
        const htmlBytes = Buffer.from(html, "utf-8");
        const sha1 = createHash("sha1").update(htmlBytes).digest("hex");

        const redirectsContent = "/*    /index.html   200";
        const redirectsBytes = Buffer.from(redirectsContent, "utf-8");
        const redirectsSha1 = createHash("sha1").update(redirectsBytes).digest("hex");

        const nfHeaders = netlifyHeaders(netlifyToken);

        const digestResp = await fetch(`${NETLIFY_API}/sites/${siteId}/deploys`, {
          method: "POST",
          headers: nfHeaders,
          body: JSON.stringify({
            files: {
              "index.html": sha1,
              "_redirects": redirectsSha1,
            },
          }),
        });

        if (digestResp.ok) {
          const deploy = await digestResp.json();
          netlifyDeployId = deploy.id;
          netlifyUrl = deploy.ssl_url || deploy.url || null;

          const required: string[] = deploy.required || [];

          if (required.includes(sha1)) {
            await fetch(`${NETLIFY_API}/deploys/${deploy.id}/files/index.html`, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${netlifyToken}`,
                "Content-Type": "application/octet-stream",
              },
              body: htmlBytes,
            });
          }

          if (required.includes(redirectsSha1)) {
            await fetch(`${NETLIFY_API}/deploys/${deploy.id}/files/_redirects`, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${netlifyToken}`,
                "Content-Type": "application/octet-stream",
              },
              body: redirectsBytes,
            });
          }
        }
      }
    } catch (err) {
      // Netlify deploy is optional — don't fail the whole publish
      console.error("[Publish] Netlify deploy failed (non-fatal):", err);
    }
  }

  // --- Update project in Supabase ---
  if (supabase) {
    try {
      await supabase
        .from("projects")
        .update({
          deployed_url: primaryUrl,
          deployed_at: new Date().toISOString(),
          deployment_status: "deployed",
          custom_domain: customDomain,
          ...(netlifySiteId ? { netlify_site_id: netlifySiteId } : {}),
        })
        .eq("id", projectId);

      // Insert deployment record
      if (netlifyDeployId) {
        await supabase.from("netlify_deployments").insert({
          tenant_id: tenantId,
          project_id: projectId,
          netlify_site_id: netlifySiteId,
          netlify_deploy_id: netlifyDeployId,
          status: "ready",
          url: primaryUrl,
        });
      }
    } catch {
      // Non-fatal — deploy succeeded even if DB update fails
    }
  }

  return NextResponse.json({
    deploy_id: netlifyDeployId || projectId,
    url: primaryUrl,
    status: "ready",
    netlify_site_id: netlifySiteId,
    netlify_url: netlifyUrl,
    custom_domain: customDomain,
  });
}
