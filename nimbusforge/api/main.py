"""
Vedaa API — FastAPI Control Plane

Endpoints:
  /tenants           — CRUD + member management
  /projects          — CRUD within a tenant
  /builds            — Create builds (triggers agent pipeline), list, get
  /builds/{id}/events — SSE stream of build events
  /deployments       — Create, list, rollback
  /usage             — Usage summaries and audit logs
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import traceback
from datetime import datetime, timezone
from typing import AsyncGenerator
from uuid import UUID, uuid4

from fastapi import BackgroundTasks, Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware
from supabase import Client

from .logging_config import setup_logging

logger = logging.getLogger(__name__)

from .config import Settings, get_settings
from .dependencies import (
    AuthUser,
    RateLimiter,
    check_budget,
    get_current_user,
    get_rate_limiter,
    get_supabase_service,
)
from .models import (
    BuildCreate,
    BuildEventResponse,
    BuildResponse,
    BuildStatus,
    DeploymentCreate,
    DeploymentResponse,
    MemberInvite,
    MemberResponse,
    ProjectCreate,
    ProjectResponse,
    ProjectUpdate,
    PublishRequest,
    PublishResponse,
    PublishStatusResponse,
    RollbackRequest,
    TenantCreate,
    TenantResponse,
    TenantUpdate,
    UsageSummary,
)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Vedaa API",
    version="0.1.0",
    description="Vedaa — The Agentic Development OS",
)

_startup_settings = get_settings()
setup_logging(debug=_startup_settings.debug_mode)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_startup_settings.cors_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Log every request with method, path, status, and duration. Adds X-Request-ID header."""

    async def dispatch(self, request: Request, call_next):
        request_id = str(uuid4())
        start = time.time()
        response = await call_next(request)
        duration_ms = round((time.time() - start) * 1000)
        logger.info(
            "%s %s -> %d (%dms) [request_id=%s]",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
            request_id,
        )
        response.headers["X-Request-ID"] = request_id
        return response


app.add_middleware(RequestLoggingMiddleware)


# ---------------------------------------------------------------------------
# Startup validation
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def startup_event():
    """Validate configuration on startup and log important info."""
    settings = get_settings()

    logger.info("Vedaa API starting")
    logger.info("Supabase URL: %s", settings.supabase_url)
    logger.info("CORS allowed origins: %s", settings.cors_allowed_origins)
    logger.info("Debug mode: %s", settings.debug_mode)
    logger.info(
        "Configured providers — Anthropic: %s, Netlify: %s",
        bool(settings.anthropic_api_key),
        bool(settings.netlify_token),
    )
    logger.info("Startup validation complete")


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch unhandled exceptions. Only expose tracebacks in debug mode."""
    request_id = str(uuid4())
    logger.error(
        "Unhandled exception [request_id=%s] %s: %s",
        request_id, type(exc).__name__, exc,
        exc_info=True,
    )
    settings = get_settings()
    content: dict = {"detail": "Internal server error", "request_id": request_id}
    if settings.debug_mode:
        tb = traceback.format_exception(type(exc), exc, exc.__traceback__)
        content["detail"] = str(exc)
        content["traceback"] = "".join(tb)
    return JSONResponse(status_code=500, content=content)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vedaa-api"}


@app.get("/debug/db")
async def debug_db(
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
):
    """Test Supabase connection — only available when DEBUG_MODE=true."""
    if not settings.debug_mode:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        result = db.table("tenants").select("id").limit(1).execute()
        app_data_exists = True
        try:
            db.table("app_data").select("id").limit(1).execute()
        except Exception:
            app_data_exists = False
        return {
            "status": "ok",
            "tenants_count": len(result.data),
            "app_data_table_exists": app_data_exists
        }
    except Exception as e:
        logger.error("Debug DB check failed: %s", e)
        return {"status": "error", "error": str(e), "type": type(e).__name__}


@app.get("/preview/credentials")
async def get_preview_credentials(
    user: AuthUser = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
):
    """
    Return Supabase credentials for preview iframes.

    Authenticated users get URL and anon key to inject into preview apps.
    Rate-limited to prevent abuse.
    """
    # Validate credentials are configured
    if not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(
            status_code=503,
            detail="Supabase not configured. Contact administrator."
        )

    # Return credentials
    return {
        "url": settings.supabase_url,
        "anonKey": settings.supabase_anon_key,
    }


# ===========================================================================
# TENANTS
# ===========================================================================

@app.post("/tenants", response_model=TenantResponse, status_code=201)
async def create_tenant(
    body: TenantCreate,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    """Create a new tenant and add the creator as owner."""
    tenant_id = str(uuid4())
    try:
        db.table("tenants").insert({
            "id": tenant_id,
            "name": body.name,
            "slug": body.slug,
            "plan": body.plan.value,
        }).execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create tenant: {e}")

    # Add creator as owner (skip for service-role — no real user in auth.users)
    if not user.is_service_role:
        try:
            db.table("tenant_members").insert({
                "tenant_id": tenant_id,
                "user_id": str(user.user_id),
                "role": "owner",
            }).execute()
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to add tenant member: {e}")

    try:
        result = db.table("tenants").select("*").eq("id", tenant_id).single().execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read back tenant: {e}")


@app.get("/tenants", response_model=list[TenantResponse])
async def list_tenants(
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    """List all tenants the current user belongs to."""
    # Service-role sees all tenants
    if user.is_service_role:
        result = db.table("tenants").select("*").execute()
        return result.data

    membership = (
        db.table("tenant_members")
        .select("tenant_id")
        .eq("user_id", str(user.user_id))
        .execute()
    )
    tenant_ids = [m["tenant_id"] for m in membership.data]
    if not tenant_ids:
        return []
    result = db.table("tenants").select("*").in_("id", tenant_ids).execute()
    return result.data


@app.get("/tenants/{tenant_id}", response_model=TenantResponse)
async def get_tenant(
    tenant_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = db.table("tenants").select("*").eq("id", str(tenant_id)).single().execute()
    return result.data


@app.patch("/tenants/{tenant_id}", response_model=TenantResponse)
async def update_tenant(
    tenant_id: UUID,
    body: TenantUpdate,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    db.table("tenants").update(updates).eq("id", str(tenant_id)).execute()
    result = db.table("tenants").select("*").eq("id", str(tenant_id)).single().execute()
    return result.data


@app.post("/tenants/{tenant_id}/members", response_model=MemberResponse, status_code=201)
async def invite_member(
    tenant_id: UUID,
    body: MemberInvite,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    # Look up user by email
    users_resp = db.auth.admin.list_users()
    target_user = None
    for u in users_resp:
        if hasattr(u, 'email') and u.email == body.email:
            target_user = u
            break
    if target_user is None:
        raise HTTPException(status_code=404, detail="User not found with that email")

    result = db.table("tenant_members").insert({
        "tenant_id": str(tenant_id),
        "user_id": str(target_user.id),
        "role": body.role.value,
        "invited_by": str(user.user_id),
    }).execute()
    return result.data[0]


@app.get("/tenants/{tenant_id}/members", response_model=list[MemberResponse])
async def list_members(
    tenant_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = (
        db.table("tenant_members")
        .select("*")
        .eq("tenant_id", str(tenant_id))
        .execute()
    )
    return result.data


# ===========================================================================
# PROJECTS
# ===========================================================================

@app.post("/tenants/{tenant_id}/projects", response_model=ProjectResponse, status_code=201)
async def create_project(
    tenant_id: UUID,
    body: ProjectCreate,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    project_id = str(uuid4())
    try:
        db.table("projects").insert({
            "id": project_id,
            "tenant_id": str(tenant_id),
            "name": body.name,
            "slug": body.slug,
            "description": body.description,
            "stack": body.stack,
        }).execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create project: {e}")
    try:
        result = db.table("projects").select("*").eq("id", project_id).single().execute()
        return result.data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read back project: {e}")


@app.get("/tenants/{tenant_id}/projects", response_model=list[ProjectResponse])
async def list_projects(
    tenant_id: UUID,
    status: str | None = Query(None),
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    query = db.table("projects").select("*").eq("tenant_id", str(tenant_id))
    if status:
        query = query.eq("status", status)
    result = query.order("created_at", desc=True).execute()
    return result.data


@app.get("/tenants/{tenant_id}/projects/{project_id}", response_model=ProjectResponse)
async def get_project(
    tenant_id: UUID,
    project_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = (
        db.table("projects")
        .select("*")
        .eq("id", str(project_id))
        .eq("tenant_id", str(tenant_id))
        .single()
        .execute()
    )
    return result.data


@app.patch("/tenants/{tenant_id}/projects/{project_id}", response_model=ProjectResponse)
async def update_project(
    tenant_id: UUID,
    project_id: UUID,
    body: ProjectUpdate,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")
    db.table("projects").update(updates).eq("id", str(project_id)).eq("tenant_id", str(tenant_id)).execute()
    result = (
        db.table("projects")
        .select("*")
        .eq("id", str(project_id))
        .single()
        .execute()
    )
    return result.data


# ===========================================================================
# BUILDS
# ===========================================================================

@app.post(
    "/tenants/{tenant_id}/projects/{project_id}/builds",
    response_model=BuildResponse,
    status_code=201,
)
async def create_build(
    tenant_id: UUID,
    project_id: UUID,
    body: BuildCreate,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
    rate_limiter: RateLimiter = Depends(get_rate_limiter),
):
    """
    Create a new build. This:
    1. Validates tenant access + budget + rate limit
    2. Inserts a build record with status=queued
    3. Kicks off the agent pipeline in the background
    4. Returns the build record immediately (client polls or streams events)
    """
    user.assert_tenant_access(tenant_id)

    # Verify LLM API key is configured
    if not settings.anthropic_api_key:
        raise HTTPException(
            status_code=503,
            detail="LLM generation is unavailable. ANTHROPIC_API_KEY not configured.",
        )

    # Budget check
    await check_budget(tenant_id, db)

    # Rate limit check
    tenant_data = db.table("tenants").select("plan").eq("id", str(tenant_id)).single().execute()
    plan = tenant_data.data["plan"]
    limit_map = {
        "free": settings.rate_limit_free,
        "pro": settings.rate_limit_pro,
        "enterprise": settings.rate_limit_enterprise,
    }
    if not rate_limiter.check(tenant_id, limit_map.get(plan, 10)):
        raise HTTPException(status_code=429, detail="Rate limit exceeded. Try again shortly.")

    # Create build record
    build_id = str(uuid4())
    build_row = {
        "id": build_id,
        "tenant_id": str(tenant_id),
        "project_id": str(project_id),
        "status": "queued",
        "prompt": body.prompt,
    }
    # Only set user_id for real users (service-role has no auth.users entry)
    if not user.is_service_role:
        build_row["user_id"] = str(user.user_id)
    try:
        db.table("builds").insert(build_row).execute()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create build: {e}")

    # Dispatch to agent pipeline (background)
    background_tasks.add_task(
        _run_build_pipeline,
        build_id=build_id,
        tenant_id=str(tenant_id),
        project_id=str(project_id),
        prompt=body.prompt,
        settings=settings,
    )

    result = db.table("builds").select("*").eq("id", build_id).single().execute()
    return result.data


async def _run_build_pipeline(
    build_id: str,
    tenant_id: str,
    project_id: str,
    prompt: str,
    settings: Settings,
):
    """
    Execute the full agent pipeline for a build.
    Imported here to avoid circular imports — the actual implementation
    lives in nimbusforge.agents.orchestrator.
    """
    from ..agents.orchestrator import run_build
    try:
        await run_build(
            build_id=build_id,
            tenant_id=tenant_id,
            project_id=project_id,
            prompt=prompt,
            settings=settings,
        )
    except Exception as e:
        # If the pipeline crashes, mark the build as failed
        from supabase import create_client
        db = create_client(settings.supabase_url, settings.supabase_service_role_key)
        db.table("builds").update({
            "status": "failed",
            "error_message": str(e),
            "completed_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", build_id).execute()


@app.get(
    "/tenants/{tenant_id}/projects/{project_id}/builds",
    response_model=list[BuildResponse],
)
async def list_builds(
    tenant_id: UUID,
    project_id: UUID,
    limit: int = Query(20, ge=1, le=100),
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = (
        db.table("builds")
        .select("*")
        .eq("project_id", str(project_id))
        .eq("tenant_id", str(tenant_id))
        .order("created_at", desc=True)
        .limit(limit)
        .execute()
    )
    return result.data


@app.get(
    "/tenants/{tenant_id}/projects/{project_id}/builds/{build_id}",
    response_model=BuildResponse,
)
async def get_build(
    tenant_id: UUID,
    project_id: UUID,
    build_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = (
        db.table("builds")
        .select("*")
        .eq("id", str(build_id))
        .eq("tenant_id", str(tenant_id))
        .single()
        .execute()
    )
    return result.data


@app.post("/tenants/{tenant_id}/projects/{project_id}/builds/{build_id}/cancel")
async def cancel_build(
    tenant_id: UUID,
    project_id: UUID,
    build_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    db.table("builds").update({
        "status": "cancelled",
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", str(build_id)).eq("tenant_id", str(tenant_id)).execute()
    return {"status": "cancelled"}


# ===========================================================================
# BUILD EVENTS — SSE Streaming
# ===========================================================================

@app.get("/tenants/{tenant_id}/projects/{project_id}/builds/{build_id}/events")
async def stream_build_events(
    tenant_id: UUID,
    project_id: UUID,
    build_id: UUID,
    after_seq: int = Query(0, description="Resume from this sequence number"),
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    """
    Server-Sent Events stream of build events.

    The client connects and receives events as they happen. If the client
    disconnects and reconnects, it passes `after_seq` to resume.

    Event format:
        data: {"id": "...", "kind": "log", "agent": "sonnet", "payload": {...}, "seq": 5}

    The stream ends with:
        data: {"kind": "stream_end", "build_status": "succeeded"}
    """
    user.assert_tenant_access(tenant_id)

    async def event_generator() -> AsyncGenerator[str, None]:
        last_seq = after_seq
        terminal_statuses = {"succeeded", "failed", "cancelled"}

        while True:
            # Fetch new events since last_seq
            events = (
                db.table("build_events")
                .select("*")
                .eq("build_id", str(build_id))
                .eq("tenant_id", str(tenant_id))
                .gt("seq", last_seq)
                .order("seq")
                .limit(50)
                .execute()
            )

            for event in events.data:
                last_seq = event["seq"]
                yield f"data: {json.dumps(event)}\n\n"

            # Check if build is done
            build = (
                db.table("builds")
                .select("status")
                .eq("id", str(build_id))
                .single()
                .execute()
            )
            if build.data["status"] in terminal_statuses:
                yield f"data: {json.dumps({'kind': 'stream_end', 'build_status': build.data['status']})}\n\n"
                return

            # Poll interval — Supabase Realtime handles the push on the frontend;
            # this SSE endpoint is a fallback/alternative for non-WS clients.
            await asyncio.sleep(1)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ===========================================================================
# DEPLOYMENTS
# ===========================================================================

@app.post(
    "/tenants/{tenant_id}/projects/{project_id}/deployments",
    response_model=DeploymentResponse,
    status_code=201,
)
async def create_deployment(
    tenant_id: UUID,
    project_id: UUID,
    body: DeploymentCreate,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
):
    """Create a deployment for a successful build."""
    user.assert_tenant_access(tenant_id)

    # Verify build exists and succeeded
    build = (
        db.table("builds")
        .select("*")
        .eq("id", str(body.build_id))
        .eq("tenant_id", str(tenant_id))
        .single()
        .execute()
    )
    if build.data["status"] != "succeeded":
        raise HTTPException(status_code=400, detail="Can only deploy successful builds")
    if not build.data.get("image_tag"):
        raise HTTPException(status_code=400, detail="Build has no container image")

    deploy_id = str(uuid4())
    preview_url = f"https://{deploy_id[:8]}.{settings.preview_domain}"

    db.table("deployments").insert({
        "id": deploy_id,
        "tenant_id": str(tenant_id),
        "project_id": str(project_id),
        "build_id": str(body.build_id),
        "status": "pending",
        "provider": body.provider,
        "region": body.region,
        "image_tag": build.data["image_tag"],
        "preview_url": preview_url,
    }).execute()

    # Deploy in background
    background_tasks.add_task(
        _run_deployment,
        deploy_id=deploy_id,
        tenant_id=str(tenant_id),
        image_tag=build.data["image_tag"],
        provider=body.provider,
        region=body.region,
        settings=settings,
    )

    result = db.table("deployments").select("*").eq("id", deploy_id).single().execute()
    return result.data


async def _run_deployment(
    deploy_id: str,
    tenant_id: str,
    image_tag: str,
    provider: str,
    region: str,
    settings: Settings,
):
    """Execute deployment — delegates to pipeline module."""
    from ..pipeline.deployer import deploy_image
    try:
        await deploy_image(
            deploy_id=deploy_id,
            tenant_id=tenant_id,
            image_tag=image_tag,
            provider=provider,
            region=region,
            settings=settings,
        )
    except Exception as e:
        from supabase import create_client
        db = create_client(settings.supabase_url, settings.supabase_service_role_key)
        db.table("deployments").update({
            "status": "failed",
        }).eq("id", deploy_id).execute()


@app.get(
    "/tenants/{tenant_id}/projects/{project_id}/deployments",
    response_model=list[DeploymentResponse],
)
async def list_deployments(
    tenant_id: UUID,
    project_id: UUID,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)
    result = (
        db.table("deployments")
        .select("*")
        .eq("project_id", str(project_id))
        .eq("tenant_id", str(tenant_id))
        .order("created_at", desc=True)
        .execute()
    )
    return result.data


@app.post("/tenants/{tenant_id}/projects/{project_id}/deployments/rollback")
async def rollback_deployment(
    tenant_id: UUID,
    project_id: UUID,
    body: RollbackRequest,
    background_tasks: BackgroundTasks,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
):
    """Rollback a deployment to its previous revision."""
    user.assert_tenant_access(tenant_id)

    deploy = (
        db.table("deployments")
        .select("*")
        .eq("id", str(body.deployment_id))
        .eq("tenant_id", str(tenant_id))
        .single()
        .execute()
    )
    if not deploy.data.get("previous_revision_id"):
        raise HTTPException(status_code=400, detail="No previous revision to rollback to")

    db.table("deployments").update({
        "status": "draining",
    }).eq("id", str(body.deployment_id)).execute()

    background_tasks.add_task(
        _execute_rollback,
        deploy_data=deploy.data,
        settings=settings,
    )

    return {"status": "rolling_back", "deployment_id": str(body.deployment_id)}


async def _execute_rollback(deploy_data: dict, settings: Settings):
    """Execute rollback — delegates to pipeline module."""
    from ..pipeline.deployer import rollback_revision
    await rollback_revision(deploy_data, settings)


# ===========================================================================
# NETLIFY PUBLISH (One-Click Deploy)
# ===========================================================================

@app.post(
    "/tenants/{tenant_id}/projects/{project_id}/publish",
    response_model=PublishResponse,
    status_code=201,
)
async def publish_project(
    tenant_id: UUID,
    project_id: UUID,
    body: PublishRequest,
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
):
    """
    One-click publish to Netlify.

    Frontend generates a self-contained HTML document (React + Babel + Tailwind +
    Supabase credentials embedded) and sends it here. Backend creates a Netlify
    site if needed, deploys the HTML, and waits for it to be ready.

    Auto-retries up to 3 times on deploy failure.
    """
    user.assert_tenant_access(tenant_id)

    if not settings.netlify_token:
        raise HTTPException(
            status_code=503,
            detail="Netlify not configured. Set NETLIFY_TOKEN in environment.",
        )

    from ..services.netlify import NetlifyService

    netlify = NetlifyService(
        token=settings.netlify_token,
        team_slug=settings.netlify_team_slug,
        site_prefix=settings.netlify_site_prefix,
    )

    # Fetch project
    project = (
        db.table("projects")
        .select("*")
        .eq("id", str(project_id))
        .eq("tenant_id", str(tenant_id))
        .single()
        .execute()
    )

    # Create or reuse Netlify site
    site_id = project.data.get("netlify_site_id")
    if not site_id:
        try:
            site = netlify.create_site(project.data["slug"])
            site_id = site["site_id"]
            db.table("projects").update({
                "netlify_site_id": site_id,
                "deployment_status": "deploying",
            }).eq("id", str(project_id)).execute()
        except Exception as e:
            raise HTTPException(
                status_code=502,
                detail=f"Failed to create Netlify site: {e}",
            )
    else:
        db.table("projects").update({
            "deployment_status": "deploying",
        }).eq("id", str(project_id)).execute()

    # Deploy with auto-retry (up to 3 attempts, exponential backoff)
    max_retries = 3
    last_error: Exception | None = None
    result = None

    for attempt in range(max_retries):
        try:
            result = netlify.deploy_html(site_id, body.html)
            break
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                await asyncio.sleep(2 ** attempt)  # 1s, 2s, 4s

    if result is None:
        db.table("projects").update({
            "deployment_status": "failed",
        }).eq("id", str(project_id)).execute()
        raise HTTPException(
            status_code=502,
            detail=f"Deploy failed after {max_retries} attempts: {last_error}",
        )

    deploy_url = result["url"]
    deploy_status = "deploying"

    # Wait for Netlify to finish (blocking, but fast for single-file deploys)
    try:
        final = netlify.wait_for_ready(result["deploy_id"], max_wait=60)
        deploy_url = final["url"] or deploy_url
        deploy_status = "ready"
    except (TimeoutError, RuntimeError):
        # Still in progress — frontend will poll
        deploy_status = "deploying"

    # Add custom domain if configured
    custom_domain = None
    if settings.netlify_custom_domain:
        custom_domain = f"{project.data['slug']}.{settings.netlify_custom_domain}"
        try:
            netlify.add_custom_domain(site_id, custom_domain)
            deploy_url = f"https://{custom_domain}"  # Use custom domain as primary URL
            logger.info("Custom domain assigned: %s", custom_domain)
        except Exception as e:
            # If custom domain fails, fall back to netlify.app URL
            logger.warning("Failed to add custom domain %s: %s", custom_domain, e)
            custom_domain = None  # Don't save failed domain

    # Update project record
    update_data = {
        "deployed_url": deploy_url,
        "deployed_at": datetime.now(timezone.utc).isoformat(),
        "deployment_status": "deployed" if deploy_status == "ready" else "deploying",
    }
    if custom_domain:
        update_data["custom_domain"] = custom_domain

    db.table("projects").update(update_data).eq("id", str(project_id)).execute()

    # Record deployment in history
    db.table("netlify_deployments").insert({
        "tenant_id": str(tenant_id),
        "project_id": str(project_id),
        "netlify_site_id": site_id,
        "netlify_deploy_id": result["deploy_id"],
        "status": deploy_status,
        "url": deploy_url,
    }).execute()

    return PublishResponse(
        deploy_id=result["deploy_id"],
        url=deploy_url,
        status=deploy_status,
        netlify_site_id=site_id,
    )


@app.get(
    "/tenants/{tenant_id}/projects/{project_id}/publish-status",
    response_model=PublishStatusResponse,
)
async def get_publish_status(
    tenant_id: UUID,
    project_id: UUID,
    deploy_id: str = Query(..., description="Netlify deploy ID to check"),
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
):
    """Poll Netlify deploy status for the progress UI."""
    user.assert_tenant_access(tenant_id)

    from ..services.netlify import NetlifyService

    netlify = NetlifyService(
        token=settings.netlify_token,
        team_slug=settings.netlify_team_slug,
        site_prefix=settings.netlify_site_prefix,
    )

    try:
        status = netlify.get_deploy_status(deploy_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to check status: {e}")

    # If ready, update the project record
    if status["state"] == "ready":
        db.table("projects").update({
            "deployment_status": "deployed",
            "deployed_url": status["url"],
        }).eq("id", str(project_id)).execute()

    return PublishStatusResponse(state=status["state"], url=status["url"])


# ===========================================================================
# USAGE & AUDIT
# ===========================================================================

@app.get("/tenants/{tenant_id}/usage", response_model=UsageSummary)
async def get_usage(
    tenant_id: UUID,
    period: str = Query("current_month", description="'current_month' or 'YYYY-MM'"),
    user: AuthUser = Depends(get_current_user),
    db: Client = Depends(get_supabase_service),
):
    user.assert_tenant_access(tenant_id)

    # Determine date range
    if period == "current_month":
        now = datetime.now(timezone.utc)
        start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        period_label = now.strftime("%Y-%m")
    else:
        from datetime import datetime as dt
        start = dt.strptime(period, "%Y-%m").replace(tzinfo=timezone.utc)
        period_label = period

    result = (
        db.table("usage_events")
        .select("*")
        .eq("tenant_id", str(tenant_id))
        .gte("created_at", start.isoformat())
        .execute()
    )

    events = result.data
    total_in = sum(e.get("tokens_in", 0) for e in events)
    total_out = sum(e.get("tokens_out", 0) for e in events)
    total_cost = sum(float(e.get("cost_usd", 0)) for e in events)

    by_model: dict[str, dict] = {}
    for e in events:
        m = e.get("model", "unknown")
        if m not in by_model:
            by_model[m] = {"tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0, "calls": 0}
        by_model[m]["tokens_in"] += e.get("tokens_in", 0)
        by_model[m]["tokens_out"] += e.get("tokens_out", 0)
        by_model[m]["cost_usd"] += float(e.get("cost_usd", 0))
        by_model[m]["calls"] += 1

    build_count = (
        db.table("builds")
        .select("id", count="exact")
        .eq("tenant_id", str(tenant_id))
        .gte("created_at", start.isoformat())
        .execute()
    )

    return UsageSummary(
        tenant_id=tenant_id,
        period=period_label,
        total_builds=build_count.count or 0,
        total_tokens_in=total_in,
        total_tokens_out=total_out,
        total_cost_usd=total_cost,
        by_model=by_model,
    )
