"""
Deployment Pipeline — Deploy to Cloud Run or Fly.io, manage previews, handle rollbacks.

Supported providers:
  - Cloud Run (GCP) — default
  - Fly.io — alternative

Each deployment gets a unique preview URL. Deployments are tracked in the
deployments table with revision IDs for rollback capability.

Health checks run post-deploy. If the service fails health checks within 60s,
auto-rollback is triggered.
"""

from __future__ import annotations

import subprocess
import time
from datetime import datetime, timezone
from uuid import uuid4

from ..api.config import Settings


def deploy_image(
    deploy_id: str,
    tenant_id: str,
    image_tag: str,
    provider: str,
    region: str,
    settings: Settings,
) -> dict:
    """
    Deploy a container image to the specified provider.
    Updates the deployment record with status, revision, and preview URL.

    Returns: {"preview_url": str, "revision_id": str, "service_name": str}
    """
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    if provider == "cloudrun":
        result = _deploy_cloudrun(deploy_id, tenant_id, image_tag, region, settings)
    elif provider == "flyio":
        result = _deploy_flyio(deploy_id, tenant_id, image_tag, region, settings)
    else:
        raise ValueError(f"Unknown deploy provider: {provider}")

    # Update deployment record
    db.table("deployments").update({
        "status": "active",
        "service_name": result["service_name"],
        "revision_id": result["revision_id"],
        "preview_url": result["preview_url"],
        "health_check_url": f"{result['preview_url']}/health",
        "last_health_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", deploy_id).execute()

    # Run health check
    healthy = _check_health(result["preview_url"], timeout_seconds=60)
    if not healthy:
        # Auto-rollback
        db.table("deployments").update({"status": "failed"}).eq("id", deploy_id).execute()
        if result.get("previous_revision"):
            _rollback_provider(provider, result["service_name"], result["previous_revision"], region, settings)

    return result


def deploy_preview(
    tenant_id: str,
    project_id: str,
    build_id: str,
    image_tag: str,
    settings: Settings,
) -> dict:
    """Quick deploy for preview — used directly from the agent pipeline."""
    deploy_id = str(uuid4())
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    preview_url = f"https://{build_id[:8]}.{settings.preview_domain}"

    db.table("deployments").insert({
        "id": deploy_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "build_id": build_id,
        "status": "pending",
        "provider": settings.deploy_provider,
        "region": settings.gcp_region,
        "image_tag": image_tag,
        "preview_url": preview_url,
    }).execute()

    result = deploy_image(
        deploy_id=deploy_id,
        tenant_id=tenant_id,
        image_tag=image_tag,
        provider=settings.deploy_provider,
        region=settings.gcp_region,
        settings=settings,
    )

    return {"preview_url": result["preview_url"], "deploy_id": deploy_id}


# ---------------------------------------------------------------------------
# Cloud Run deployment
# ---------------------------------------------------------------------------

def _deploy_cloudrun(
    deploy_id: str,
    tenant_id: str,
    image_tag: str,
    region: str,
    settings: Settings,
) -> dict:
    """Deploy to Google Cloud Run."""
    service_name = f"nf-{tenant_id[:8]}-{deploy_id[:8]}"

    # Check if service exists (to capture previous revision for rollback)
    previous_revision = None
    check = subprocess.run(
        [
            "gcloud", "run", "services", "describe", service_name,
            "--region", region,
            "--project", settings.gcp_project,
            "--format", "value(status.latestReadyRevisionName)",
        ],
        capture_output=True, text=True,
    )
    if check.returncode == 0 and check.stdout.strip():
        previous_revision = check.stdout.strip()

    # Deploy
    result = subprocess.run(
        [
            "gcloud", "run", "deploy", service_name,
            "--image", image_tag,
            "--region", region,
            "--project", settings.gcp_project,
            "--platform", "managed",
            "--allow-unauthenticated",
            "--port", "8080",
            "--memory", "512Mi",
            "--cpu", "1",
            "--min-instances", "0",
            "--max-instances", "3",
            "--timeout", "300",
            "--set-env-vars", f"BUILD_ID={deploy_id}",
            "--labels", f"tenant={tenant_id[:8]},managed-by=nimbusforge",
            "--format", "value(status.url)",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Cloud Run deploy failed: {result.stderr}")

    service_url = result.stdout.strip()

    # Get the new revision name
    rev_result = subprocess.run(
        [
            "gcloud", "run", "services", "describe", service_name,
            "--region", region,
            "--project", settings.gcp_project,
            "--format", "value(status.latestReadyRevisionName)",
        ],
        capture_output=True, text=True,
    )
    revision_id = rev_result.stdout.strip() if rev_result.returncode == 0 else deploy_id[:8]

    # Store previous revision for rollback
    if previous_revision:
        from supabase import create_client
        db = create_client(settings.supabase_url, settings.supabase_service_role_key)
        db.table("deployments").update({
            "previous_revision_id": previous_revision,
        }).eq("id", deploy_id).execute()

    return {
        "preview_url": service_url or f"https://{service_name}-{settings.gcp_project}.a.run.app",
        "revision_id": revision_id,
        "service_name": service_name,
        "previous_revision": previous_revision,
    }


# ---------------------------------------------------------------------------
# Fly.io deployment
# ---------------------------------------------------------------------------

def _deploy_flyio(
    deploy_id: str,
    tenant_id: str,
    image_tag: str,
    region: str,
    settings: Settings,
) -> dict:
    """Deploy to Fly.io."""
    app_name = f"nf-{tenant_id[:8]}-{deploy_id[:8]}"

    # Check if app exists
    check = subprocess.run(
        ["fly", "apps", "list", "--json", "-o", settings.fly_org],
        capture_output=True, text=True,
    )
    app_exists = app_name in (check.stdout or "")

    if not app_exists:
        # Create app
        subprocess.run(
            [
                "fly", "apps", "create", app_name,
                "--org", settings.fly_org,
            ],
            check=True, capture_output=True,
        )

    # Get current release for rollback
    previous_revision = None
    if app_exists:
        rel = subprocess.run(
            ["fly", "releases", "--json", "-a", app_name],
            capture_output=True, text=True,
        )
        if rel.returncode == 0:
            import json
            releases = json.loads(rel.stdout or "[]")
            if releases:
                previous_revision = str(releases[0].get("Version", ""))

    # Deploy
    result = subprocess.run(
        [
            "fly", "deploy",
            "--app", app_name,
            "--image", image_tag,
            "--region", region or "iad",
            "--ha=false",
            "--vm-memory", "512",
            "--now",
        ],
        capture_output=True,
        text=True,
        timeout=300,
    )

    if result.returncode != 0:
        raise RuntimeError(f"Fly.io deploy failed: {result.stderr}")

    return {
        "preview_url": f"https://{app_name}.fly.dev",
        "revision_id": deploy_id[:8],
        "service_name": app_name,
        "previous_revision": previous_revision,
    }


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

def _check_health(url: str, timeout_seconds: int = 60) -> bool:
    """
    Poll the health endpoint until it responds 200 or timeout.
    Returns True if healthy, False if timed out.
    """
    import httpx

    health_url = f"{url}/health"
    deadline = time.time() + timeout_seconds

    while time.time() < deadline:
        try:
            resp = httpx.get(health_url, timeout=5)
            if resp.status_code == 200:
                return True
        except (httpx.HTTPError, httpx.TimeoutException):
            pass
        time.sleep(3)

    return False


# ---------------------------------------------------------------------------
# Rollback
# ---------------------------------------------------------------------------

def rollback_revision(deploy_data: dict, settings: Settings):
    """Rollback a deployment to its previous revision."""
    provider = deploy_data["provider"]
    service_name = deploy_data["service_name"]
    previous_revision = deploy_data.get("previous_revision_id")
    region = deploy_data.get("region", settings.gcp_region)

    if not previous_revision:
        raise ValueError("No previous revision to rollback to")

    _rollback_provider(provider, service_name, previous_revision, region, settings)

    # Update status
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)
    db.table("deployments").update({
        "status": "rolled_back",
    }).eq("id", deploy_data["id"]).execute()


def _rollback_provider(provider: str, service_name: str, revision: str, region: str, settings: Settings):
    """Execute provider-specific rollback."""
    if provider == "cloudrun":
        subprocess.run(
            [
                "gcloud", "run", "services", "update-traffic", service_name,
                "--to-revisions", f"{revision}=100",
                "--region", region,
                "--project", settings.gcp_project,
            ],
            check=True, capture_output=True, timeout=120,
        )
    elif provider == "flyio":
        subprocess.run(
            [
                "fly", "deploy",
                "--app", service_name,
                "--image", f"registry.fly.io/{service_name}:{revision}",
                "--now",
            ],
            check=True, capture_output=True, timeout=120,
        )
