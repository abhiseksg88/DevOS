"""
Preview Routing Strategy — Subdomain-based preview URLs with SSL and cleanup.

Strategy: Subdomain routing
  URL format: https://{build_id_prefix}.preview.vedaa.dev
  SSL: Wildcard certificate via Let's Encrypt + Caddy automatic HTTPS
  Proxy: Caddy reverse proxy to Cloud Run/Fly.io service URL

Why subdomain over path routing:
  - Clean URLs (no /preview/abc123 prefix that breaks relative paths)
  - Each preview is isolated (cookies, localStorage, CORS)
  - Wildcard SSL covers all previews with one cert
  - Easy to add per-preview auth later

Cleanup:
  - Stale detection: no HTTP traffic in 72 hours
  - Soft delete: stop container (save image), remove from router
  - Hard delete: after 7 days, delete container + image + storage
  - Active previews (recent traffic) are exempt from cleanup
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from ..api.config import Settings


# ---------------------------------------------------------------------------
# Caddyfile generation for preview routing
# ---------------------------------------------------------------------------

def generate_caddyfile(previews: list[dict], settings: Settings) -> str:
    """
    Generate a Caddyfile that routes preview subdomains to their backing services.

    Each preview dict: {
        "build_id": "abc123...",
        "service_url": "https://nf-xxx-yyy.a.run.app",
        "auth_required": false
    }
    """
    blocks = []

    # Global options
    blocks.append("""\
{
    email ssl@vedaa.dev
    acme_ca https://acme-v02.api.letsencrypt.org/directory
}
""")

    # Wildcard cert for all previews
    blocks.append(f"""\
*.{settings.preview_domain} {{
    tls {{
        dns cloudflare {{env.CLOUDFLARE_API_TOKEN}}
    }}

    @health path /health
    handle @health {{
        respond "ok" 200
    }}

    # Log all requests for traffic tracking (used by cleanup)
    log {{
        output file /var/log/caddy/preview-access.log {{
            roll_size 100mb
            roll_keep 5
        }}
        format json
    }}
""")

    # Add route for each active preview
    for preview in previews:
        prefix = preview["build_id"][:8]
        service_url = preview["service_url"]

        route_block = f"""\
    @{prefix} host {prefix}.{settings.preview_domain}
    handle @{prefix} {{
        reverse_proxy {service_url} {{
            header_up Host {{upstream_hostport}}
            header_up X-NimbusForge-Build {preview["build_id"]}
            transport http {{
                tls
                tls_insecure_skip_verify
            }}
        }}
    }}
"""
        blocks.append(route_block)

    # Fallback for unknown subdomains
    blocks.append(f"""\
    # Fallback — unknown preview
    handle {{
        respond "Preview not found or expired. Build a new version to get a fresh preview." 404
    }}
}}
""")

    return "\n".join(blocks)


# ---------------------------------------------------------------------------
# Preview cleanup logic
# ---------------------------------------------------------------------------

def find_stale_previews(settings: Settings) -> list[dict]:
    """
    Query deployments table for previews with no recent traffic.

    A preview is stale if:
    - status is 'active'
    - last_health_at is more than preview_stale_hours ago
    - OR no HTTP traffic logged in access log for that subdomain

    Returns list of deployment records to clean up.
    """
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    cutoff = (
        datetime.now(timezone.utc) - timedelta(hours=settings.preview_stale_hours)
    ).isoformat()

    stale = (
        db.table("deployments")
        .select("*")
        .eq("status", "active")
        .lt("last_health_at", cutoff)
        .execute()
    )

    return stale.data


def cleanup_stale_previews(settings: Settings) -> dict:
    """
    Stop stale preview containers and update their status.

    Cleanup steps:
    1. Find stale previews (no traffic in stale window)
    2. Stop the backing container (Cloud Run -> 0 instances, Fly -> stop)
    3. Update deployment status to 'stopped'
    4. For previews stopped > delete_days ago, hard delete

    Returns: {"stopped": int, "deleted": int}
    """
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    stopped_count = 0
    deleted_count = 0

    # Phase 1: Soft stop stale active previews
    stale = find_stale_previews(settings)
    for deploy in stale:
        try:
            _stop_preview(deploy, settings)
            db.table("deployments").update({
                "status": "stopped",
            }).eq("id", deploy["id"]).execute()
            stopped_count += 1
        except Exception:
            pass  # Log and continue — don't let one failure block others

    # Phase 2: Hard delete old stopped previews
    delete_cutoff = (
        datetime.now(timezone.utc) - timedelta(days=settings.preview_delete_days)
    ).isoformat()

    old_stopped = (
        db.table("deployments")
        .select("*")
        .eq("status", "stopped")
        .lt("updated_at", delete_cutoff)
        .execute()
    )

    for deploy in old_stopped.data:
        try:
            _delete_preview(deploy, settings)
            db.table("deployments").delete().eq("id", deploy["id"]).execute()
            deleted_count += 1
        except Exception:
            pass

    return {"stopped": stopped_count, "deleted": deleted_count}


def _stop_preview(deploy: dict, settings: Settings):
    """Stop the backing container without deleting it."""
    import subprocess

    if deploy["provider"] == "cloudrun":
        # Scale to 0 instances
        subprocess.run(
            [
                "gcloud", "run", "services", "update", deploy["service_name"],
                "--min-instances", "0",
                "--max-instances", "0",
                "--region", deploy.get("region", settings.gcp_region),
                "--project", settings.gcp_project,
            ],
            capture_output=True, timeout=60,
        )
    elif deploy["provider"] == "flyio":
        subprocess.run(
            ["fly", "scale", "count", "0", "--app", deploy["service_name"]],
            capture_output=True, timeout=60,
        )


def _delete_preview(deploy: dict, settings: Settings):
    """Hard delete the backing container and service."""
    import subprocess

    if deploy["provider"] == "cloudrun":
        subprocess.run(
            [
                "gcloud", "run", "services", "delete", deploy["service_name"],
                "--region", deploy.get("region", settings.gcp_region),
                "--project", settings.gcp_project,
                "--quiet",
            ],
            capture_output=True, timeout=60,
        )
    elif deploy["provider"] == "flyio":
        subprocess.run(
            ["fly", "apps", "destroy", deploy["service_name"], "--yes"],
            capture_output=True, timeout=60,
        )


# ---------------------------------------------------------------------------
# Caddy config reload (hot-reload without downtime)
# ---------------------------------------------------------------------------

def reload_caddy_config(previews: list[dict], settings: Settings):
    """
    Regenerate Caddyfile and hot-reload Caddy.
    This is called when previews are added or removed.
    """
    import subprocess

    caddyfile_content = generate_caddyfile(previews, settings)

    # Write to Caddy config path
    caddy_config_path = "/etc/caddy/Caddyfile"
    with open(caddy_config_path, "w") as f:
        f.write(caddyfile_content)

    # Hot-reload (no downtime)
    subprocess.run(
        ["caddy", "reload", "--config", caddy_config_path],
        capture_output=True, timeout=30,
    )
