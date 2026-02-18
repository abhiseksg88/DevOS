/**
 * Publish API route — deploys a project to its own Netlify site and maps
 * a custom subdomain (e.g. {slug}.vedaa.io) so users get a clean URL.
 *
 * Flow:
 *   1. Create (or reuse) a per-project Netlify site.
 *   2. Deploy the self-contained HTML via the file-digest API.
 *   3. Add a custom domain alias ({slug}.{NF_CUSTOM_DOMAIN}) to the site
 *      so that Netlify routes the subdomain directly to the deployed app.
 *   4. Store the result in Supabase.
 *
 * Prerequisite DNS: A wildcard CNAME record for *.vedaa.io (or your domain)
 * pointing to Netlify's load balancer (e.g. apex-loadbalancer.netlify.com).
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
    customSubdomain?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { html, projectId, projectSlug, projectName, tenantId, customSubdomain } = body;
  if (!html || !projectId || !projectSlug) {
    return NextResponse.json(
      { error: "html, projectId, and projectSlug are required" },
      { status: 400 }
    );
  }

  // Use custom subdomain if provided, otherwise fall back to project slug
  const subdomainSlug = customSubdomain || projectSlug;

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

  // --- Build the custom domain for this project ---
  const customDomain = customDomainBase ? `${subdomainSlug}.${customDomainBase}` : null;

  // --- Deploy to Netlify ---
  let netlifyDeployId: string | null = null;
  let netlifySiteId: string | null = null;
  let netlifyUrl: string | null = null;
  let domainMapped = false;

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
        let siteName = `${sitePrefix}-${subdomainSlug}`;
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

        // --- Map custom domain to this Netlify site ---
        // Add the subdomain (e.g. meal-planner.vedaa.io) as a domain alias
        // so Netlify routes traffic for that subdomain to this site.
        // Requires *.vedaa.io wildcard DNS pointing to Netlify.
        if (customDomain) {
          try {
            // First check if domain is already added (avoid duplicates)
            const domainsResp = await fetch(
              `${NETLIFY_API}/sites/${siteId}`,
              { headers: { Authorization: `Bearer ${netlifyToken}` } }
            );
            let alreadyMapped = false;
            if (domainsResp.ok) {
              const siteData = await domainsResp.json();
              const aliases: string[] = siteData.domain_aliases || [];
              const primaryDomain: string = siteData.custom_domain || "";
              alreadyMapped =
                primaryDomain === customDomain ||
                aliases.includes(customDomain);
            }

            if (!alreadyMapped) {
              // Use the site update endpoint to set the custom domain
              const domainResp = await fetch(
                `${NETLIFY_API}/sites/${siteId}`,
                {
                  method: "PATCH",
                  headers: netlifyHeaders(netlifyToken),
                  body: JSON.stringify({
                    custom_domain: customDomain,
                  }),
                }
              );
              if (domainResp.ok) {
                domainMapped = true;
                console.log(
                  `[Publish] Mapped custom domain ${customDomain} to site ${siteId}`
                );
              } else {
                const errText = await domainResp.text();
                console.error(
                  `[Publish] Failed to map domain ${customDomain}: ${domainResp.status} ${errText}`
                );
              }
            } else {
              domainMapped = true;
              console.log(
                `[Publish] Domain ${customDomain} already mapped to site ${siteId}`
              );
            }
          } catch (domainErr) {
            console.error(
              "[Publish] Domain mapping failed (non-fatal):",
              domainErr
            );
          }
        }
      }
    } catch (err) {
      // Netlify deploy is optional — don't fail the whole publish
      console.error("[Publish] Netlify deploy failed (non-fatal):", err);
    }
  }

  // --- Determine the primary URL to show the user ---
  // If custom domain was mapped, use it. Otherwise fall back to the
  // Netlify default URL, then the path-based URL.
  const primaryUrl = customDomain && domainMapped
    ? `https://${customDomain}`
    : netlifyUrl
      ? netlifyUrl
      : `https://vedaa.io/p/${subdomainSlug}`;

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
          // Update slug to match chosen subdomain so serve-app can resolve it
          ...(customSubdomain ? { slug: subdomainSlug } : {}),
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
