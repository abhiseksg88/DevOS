"""
Vedaa Agent Orchestrator — LangGraph Multi-Agent Pipeline

Graph:  Planner (Opus) -> Discriminator -> Scaffolder (DeepSeek) -> Coder (Sonnet)
            |                                                         ^    |
            +-- Ledger read                                           |    v
            +-- AST graph load                                   Reviewer (Haiku)
            +-- Vector context                                        |
                                                                 Sentinel (auto-heal)
                                                                      |
                                                                 Committer -> Deployer

Key behaviors:
- Context Prism: AST graph + Ledger + Vector memory for context pruning
- Discriminator: Backend-enforced genesis/surgical mode selection
- Patch-only: Coder outputs unified diffs, never full files
- Stitch & Continue: Truncated responses are auto-stitched
- Sentinel: Auto-heal loop (eslint + tsc) after every patch
- Plan caching: identical prompts within TTL skip Opus call
- Usage logging: every LLM call recorded with tokens + cost
- Retry/fallback: Opus->Sonnet, Sonnet->DeepSeek on provider failure
- Max iterations: Coder<->Reviewer loop breaks at max_agent_iterations
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any, TypedDict
from uuid import uuid4

from langgraph.graph import END, StateGraph

from ..api.config import Settings, get_settings
from .llm_router import call_llm, ModelTier
from .prompts import (
    CODER_SYSTEM,
    PLANNER_SYSTEM,
    REVIEWER_SYSTEM,
    SCAFFOLDER_SYSTEM,
    REQUIREMENTS_SYSTEM,
    DESIGN_SYSTEM,
    FRONTEND_SYSTEM,
    BACKEND_SPEC_SYSTEM,
    INTEGRATION_SYSTEM,
    PRE_REVIEW_SYSTEM,
    COMMENTARY_SYSTEM,
    VISION_SYSTEM,  # noqa: F401 — available for vision_node (Phase 2)
)
from ..services.ast_graph import (
    build_dependency_graph,
    get_impacted_files,
    load_graph,
    persist_graph,
)
from ..services.ledger import (
    append_decision,
    get_ledger_context,
)
from ..services.vector_memory import (
    get_vector_context,
    store_file_summary,
)
from ..services.discriminator import (
    BuildMode,
    classify_build,
    enforce_mode_constraints,
)
from ..services.sentinel import run_sentinel
from ..services.patch_apply import apply_all_patches

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Neural Nexus helpers — safe wrappers that never break the pipeline
# ---------------------------------------------------------------------------

def _nexus_start(
    settings: Settings,
    tenant_id: str,
    project_id: str,
    build_id: str,
    agent_role: str,
    agent_step: str,
    model_tier: str,
    model_id: str,
    input_summary: str,
) -> tuple:
    """Start a Nexus agent execution record. Returns (nexus_engine | None, exec_id | '')."""
    try:
        from ..nexus.engine import NexusEngine
        nexus = NexusEngine(settings)
        exec_id = nexus.start_agent_execution(
            tenant_id=tenant_id,
            project_id=project_id,
            build_id=build_id,
            agent_role=agent_role,
            agent_step=agent_step,
            model_tier=model_tier,
            model_id=model_id,
            input_summary=input_summary[:500] if input_summary else None,
        )
        return nexus, exec_id
    except Exception as _e:
        logger.debug("Nexus start_agent_execution skipped: %s", _e)
        return None, ""


def _nexus_complete(
    nexus,
    exec_id: str,
    status: str,
    output_summary: str | None = None,
    tokens_in: int = 0,
    tokens_out: int = 0,
    cost_usd: float = 0.0,
    latency_ms: int = 0,
    error: str | None = None,
) -> None:
    """Complete a Nexus agent execution record."""
    if nexus is None or not exec_id:
        return
    try:
        nexus.complete_agent_execution(
            execution_id=exec_id,
            status=status,
            output_summary=output_summary[:500] if output_summary else None,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            cost_usd=cost_usd,
            latency_ms=latency_ms,
            error=error,
        )
    except Exception as _e:
        logger.debug("Nexus complete_agent_execution skipped: %s", _e)


# ---------------------------------------------------------------------------
# Supabase helper (uses service-role)
# ---------------------------------------------------------------------------

def _get_db(settings: Settings):
    from supabase import create_client
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def _ensure_app_data_table(db, settings: Settings) -> bool:
    """Ensure the app_data table exists. Auto-creates it if missing.

    Uses the service-role key to create the table via Supabase SQL API.
    Returns True if table exists or was created, False on failure.
    """
    import logging
    _tbl_logger = logging.getLogger(__name__)

    try:
        db.table("app_data").select("id").limit(1).execute()
        return True
    except Exception as e:
        error_msg = str(e).lower()

        if "relation" not in error_msg and "does not exist" not in error_msg and "not found" not in error_msg:
            _tbl_logger.info("Database check error (non-critical): %s", e)
            return True

        # Table is missing — attempt to auto-create it
        _tbl_logger.warning("app_data table not found. Attempting auto-creation...")

        create_sql = """
        CREATE TABLE IF NOT EXISTS app_data (
            id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
            tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            app_instance_id TEXT NOT NULL,
            collection      TEXT NOT NULL,
            record_id       TEXT NOT NULL,
            data            JSONB NOT NULL,
            version         INTEGER NOT NULL DEFAULT 1,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(project_id, app_instance_id, collection, record_id)
        );
        CREATE INDEX IF NOT EXISTS idx_app_data_project_collection ON app_data(project_id, collection);
        CREATE INDEX IF NOT EXISTS idx_app_data_lookup ON app_data(project_id, app_instance_id, collection, record_id);
        CREATE INDEX IF NOT EXISTS idx_app_data_created ON app_data(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_app_data_tenant ON app_data(tenant_id);
        ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
        DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_select') THEN
                CREATE POLICY app_data_select ON app_data FOR SELECT USING (tenant_id = ANY(public.get_tenant_ids()));
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_insert') THEN
                CREATE POLICY app_data_insert ON app_data FOR INSERT WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_update') THEN
                CREATE POLICY app_data_update ON app_data FOR UPDATE
                    USING (tenant_id = ANY(public.get_tenant_ids()))
                    WITH CHECK (tenant_id = ANY(public.get_tenant_ids()));
            END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'app_data' AND policyname = 'app_data_delete') THEN
                CREATE POLICY app_data_delete ON app_data FOR DELETE USING (tenant_id = ANY(public.get_tenant_ids()));
            END IF;
        END $$;
        """

        try:
            import httpx
            url = settings.supabase_url.rstrip("/")
            headers = {
                "apikey": settings.supabase_service_role_key,
                "Authorization": f"Bearer {settings.supabase_service_role_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            }

            # ----- Approach 1: Direct PostgreSQL connection (most reliable) -----
            db_url = getattr(settings, 'database_url', None) or getattr(settings, 'supabase_db_url', None)
            if db_url:
                try:
                    import psycopg2
                    conn = psycopg2.connect(db_url)
                    conn.autocommit = True
                    with conn.cursor() as cur:
                        cur.execute(create_sql)
                    conn.close()
                    _tbl_logger.info("app_data table auto-created via direct DB connection.")
                    return True
                except ImportError:
                    _tbl_logger.info("psycopg2 not installed, trying HTTP approach...")
                except Exception as pg_err:
                    _tbl_logger.warning("Direct DB creation failed: %s, trying HTTP...", pg_err)

            # ----- Approach 2: Supabase SQL HTTP API (/pg/query for self-hosted) -----
            for endpoint in [
                f"{url}/rest/v1/rpc/exec_sql",         # Custom RPC function if available
                f"{url}/pg/query",                       # Self-hosted Supabase pgMeta
            ]:
                try:
                    resp = httpx.post(
                        endpoint,
                        json={"query": create_sql},
                        headers=headers,
                        timeout=30,
                    )
                    if resp.status_code < 400:
                        _tbl_logger.info("app_data table auto-created via %s.", endpoint)
                        return True
                except Exception:
                    continue

            # ----- Approach 3: Execute each statement via PostgREST RPC -----
            # Create a minimal table without the complex DDL
            simple_sql = (
                "CREATE TABLE IF NOT EXISTS app_data ("
                "id UUID PRIMARY KEY DEFAULT gen_random_uuid(),"
                "tenant_id UUID NOT NULL,"
                "project_id UUID NOT NULL,"
                "app_instance_id TEXT NOT NULL DEFAULT '',"
                "collection TEXT NOT NULL,"
                "record_id TEXT NOT NULL,"
                "data JSONB NOT NULL DEFAULT '{}'::jsonb,"
                "version INTEGER NOT NULL DEFAULT 1,"
                "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                "updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),"
                "UNIQUE(project_id, app_instance_id, collection, record_id)"
                ");"
            )
            # Use the Supabase dashboard SQL endpoint if available
            try:
                resp = httpx.post(
                    f"{url}/rest/v1/rpc/exec_sql",
                    json={"sql": simple_sql},
                    headers=headers,
                    timeout=30,
                )
                if resp.status_code < 400:
                    _tbl_logger.info("app_data table created via exec_sql RPC.")
                    return True
            except Exception:
                pass

            _tbl_logger.warning(
                "Auto-creation failed. Please run the migration manually:\n"
                "  supabase db push\n"
                "  OR paste supabase/migrations/004_app_data_table.sql into the SQL editor.\n"
                "  OR set DATABASE_URL in env for direct connection.",
            )
            return False
        except Exception as create_err:
            _tbl_logger.warning(
                "Could not auto-create app_data table: %s\n"
                "Run manually: supabase db push\n"
                "Or paste supabase/migrations/004_app_data_table.sql into the SQL editor.",
                create_err,
            )
            return False


# ---------------------------------------------------------------------------
# State schema for the LangGraph graph
# ---------------------------------------------------------------------------

class BuildState(TypedDict):
    # Identifiers
    build_id: str
    tenant_id: str
    project_id: str
    user_id: str  # For Nexus persona lookup
    prompt: str
    settings: dict  # serialized Settings

    # Memory context (Context Prism)
    architecture_md: str
    api_contracts_md: str
    project_manifest: dict
    existing_files: dict[str, str]  # path -> content (relevant subset)
    ast_graph: dict | None          # Layer 1: HOT - dependency graph
    ledger_context: str             # Layer 2: WARM - architectural ledger
    vector_context: str             # Layer 3: COLD - semantic search results
    integration_context: str        # Layer 4: active integrations (Stripe, OpenAI, etc.)

    # Discriminator result
    build_mode: str                 # "genesis" | "surgical"
    genesis_files: list[str]        # files to create (genesis mode)
    surgical_files: list[str]       # files to patch (surgical mode)

    # Pipeline outputs
    plan: dict | None
    plan_from_cache: bool
    scaffold_files: dict[str, str]  # path -> content (new files only)
    patches: list[str]              # unified diff strings
    review_result: dict | None      # {"approved": bool, "findings": [...]}
    review_iterations: int

    # HITL checkpoint (architecture plan approval)
    hitl_approved: bool             # Whether the HITL gate has been approved
    hitl_modified_plan: dict | None # Modified plan from user, if any

    # --- Multi-modal pipeline stages (new) ---
    # Stage 0: Requirements (GPT-4o)
    requirements: dict | None           # Structured PRD from GPT-4o
    requirements_approved: bool         # HITL gate A: requirements approved
    figma_key: str | None               # Figma file key (if user provides Figma URL)

    # Stage 1: Design Contract
    design_contract: dict | None        # Design Contract (from Figma or AI-generated)
    design_approved: bool               # HITL gate B: design approved

    # Stage 2: Frontend-first build
    frontend_files: dict[str, str]      # Frontend-only files (no backend calls)
    frontend_approved: bool             # HITL gate C: frontend visual approval

    # Stage 3: Backend spec
    backend_spec: dict | None           # Backend schema reverse-engineered from frontend

    # Build phase tracker
    build_phase: str                    # "requirements|design|frontend|backend|integration|review"

    # Sentinel results
    sentinel_result: dict | None    # auto-heal loop results

    # Deployment
    commit_sha: str | None
    image_tag: str | None
    deploy_url: str | None

    # Tracking
    event_seq: int
    total_tokens_in: int
    total_tokens_out: int
    total_cost_usd: float
    model_usage: dict[str, dict]
    error: str | None


# ---------------------------------------------------------------------------
# Event emitter — writes to build_events table for live streaming
# ---------------------------------------------------------------------------

def _emit_event(
    state: BuildState,
    kind: str,
    agent: str | None,
    payload: dict,
    settings: Settings,
) -> int:
    db = _get_db(settings)
    seq = state["event_seq"] + 1
    db.table("build_events").insert({
        "id": str(uuid4()),
        "tenant_id": state["tenant_id"],
        "build_id": state["build_id"],
        "kind": kind,
        "agent": agent,
        "payload": payload,
        "seq": seq,
    }).execute()
    return seq


def _update_build_status(state: BuildState, status: str, settings: Settings, **extra):
    db = _get_db(settings)
    update = {"status": status, **extra}
    db.table("builds").update(update).eq("id", state["build_id"]).execute()


def _log_usage(state: BuildState, model: str, tokens_in: int, tokens_out: int, cost: float, settings: Settings):
    db = _get_db(settings)
    db.table("usage_events").insert({
        "id": str(uuid4()),
        "tenant_id": state["tenant_id"],
        "build_id": state["build_id"],
        "event_type": "llm_call",
        "model": model,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost,
        "metadata": {"project_id": state["project_id"]},
    }).execute()

    # Increment tenant spend
    db.rpc("increment_tenant_spend", {
        "t_id": state["tenant_id"],
        "amount": cost,
    }).execute()


# ---------------------------------------------------------------------------
# Helper: Ingest planner proposal into Neural Nexus Business Logic Layer
# ---------------------------------------------------------------------------

def _ingest_proposal_to_nexus(plan: dict, state: BuildState, settings: Settings):
    """Write the planner's domain proposal (roles, schema, security) to Nexus.

    Uses NexusEngine.upsert_business_logic() which is idempotent
    (on_conflict=project_id,entity_type,entity_path), so cached plans
    can safely re-ingest without duplicates.
    """
    proposal = plan.get("proposal", {})
    if not proposal:
        return

    try:
        from ..nexus.engine import NexusEngine
        nexus = NexusEngine(settings)

        # Ingest roles as business logic entries
        for role in proposal.get("roles", []):
            nexus.upsert_business_logic(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                entity_type="role",
                entity_path=f"auth/roles/{role['name']}",
                entity_name=role["name"],
                purpose=f"Role with permissions: {', '.join(role.get('can', []))}",
                domain="auth",
                business_rules=role.get("can", []),
                confidence=0.9,
                source="planner_proposal",
            )

        # Ingest schema entities as business logic entries
        for entity_name, entity_def in proposal.get("schema", {}).items():
            fields = entity_def.get("fields", []) if isinstance(entity_def, dict) else []
            owner = entity_def.get("owner", "any") if isinstance(entity_def, dict) else "any"
            nexus.upsert_business_logic(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                entity_type="collection",
                entity_path=f"data/{entity_name}",
                entity_name=entity_name,
                purpose=f"Collection with fields: {', '.join(fields)}",
                domain="data",
                business_rules=[f"owner: {owner}"],
                confidence=0.9,
                source="planner_proposal",
            )

        # Ingest security posture
        security = proposal.get("security", {})
        if security and isinstance(security, dict):
            nexus.upsert_business_logic(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                entity_type="security_policy",
                entity_path="security/posture",
                entity_name="app_security",
                purpose=(
                    f"Auth: {security.get('auth_required', False)}, "
                    f"RBAC: {security.get('rbac', False)}, "
                    f"Isolation: {security.get('data_isolation', 'public')}"
                ),
                domain="security",
                business_rules=[
                    f"sensitive_fields: {security.get('sensitive_fields', [])}",
                    f"audit_trail: {security.get('audit_trail', False)}",
                ],
                confidence=0.9,
                source="planner_proposal",
            )

    except Exception as nexus_err:
        logger.warning("Early Nexus ingestion failed (non-fatal): %s", nexus_err)


# ---------------------------------------------------------------------------
# Node: PLANNER (Opus — architecture + task breakdown)
# ---------------------------------------------------------------------------

def planner_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])

    # ------------------------------------------------------------------
    # Fast-path: resume after HITL approval — skip expensive re-planning
    # The approved plan is already in state["plan"]; no LLM call needed
    # unless it's a proposal that needs converting to a task list.
    # ------------------------------------------------------------------
    if state.get("hitl_approved"):
        plan = state.get("plan") or {}

        # Case 1: Full plan with tasks — run discriminator only, no LLM call
        if plan.get("tasks"):
            disc_result = classify_build(
                state["tenant_id"], state["project_id"], plan,
                state["existing_files"], settings,
            )
            plan["needs_scaffold"] = disc_result["overall_mode"] == "genesis"
            return {
                "plan": plan,
                "plan_from_cache": False,
                "build_mode": disc_result["overall_mode"],
                "genesis_files": disc_result["genesis_files"],
                "surgical_files": disc_result["surgical_files"],
                "event_seq": state["event_seq"],
            }

        # Case 2: Proposal approved — one LLM call to convert to task list
        if plan.get("proposal"):
            _update_build_status(state, "planning", settings,
                started_at=datetime.now(timezone.utc).isoformat())
            state["event_seq"] = _emit_event(state, "agent_start", "opus",
                {"agent": "planner", "message": "Proposal approved — generating full task list..."}, settings)
            context = _build_context(state)
            messages = [
                {"role": "system", "content": PLANNER_SYSTEM},
                {"role": "user", "content": (
                    f"## Project Context\n{context}\n\n"
                    f"## PROPOSAL APPROVED\nThe following proposal was approved "
                    f"by the user:\n```json\n"
                    f"{json.dumps(plan['proposal'], indent=2)}\n```\n\n"
                    f"## Original Request\n{state['prompt']}\n\n"
                    f"Generate the full task list (MODE 2: EXECUTION). "
                    f"Keep the proposal object intact."
                )},
            ]
            response = call_llm(ModelTier.OPUS, messages, settings)
            plan = _parse_json_response(response["content"])
            disc_result = classify_build(
                state["tenant_id"], state["project_id"], plan,
                state["existing_files"], settings,
            )
            plan["needs_scaffold"] = disc_result["overall_mode"] == "genesis"
            state["event_seq"] = _emit_event(state, "agent_end", "opus",
                {"agent": "planner", "plan_summary": plan.get("summary", "")}, settings)
            return {
                "plan": plan,
                "plan_from_cache": False,
                "build_mode": disc_result["overall_mode"],
                "genesis_files": disc_result["genesis_files"],
                "surgical_files": disc_result["surgical_files"],
                "event_seq": state["event_seq"],
                "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
                "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
                "total_cost_usd": state["total_cost_usd"] + response["cost"],
                "model_usage": _update_model_usage(state["model_usage"], "opus", response),
            }

    _update_build_status(state, "planning", settings, started_at=datetime.now(timezone.utc).isoformat())
    state["event_seq"] = _emit_event(state, "agent_start", "opus", {"agent": "planner", "message": "Planning architecture and tasks..."}, settings)
    _planner_t0 = time.monotonic()
    _nexus_eng, _nexus_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "shadow_cto", "plan", "opus", settings.model_opus,
        input_summary=state.get("prompt", "")[:500],
    )

    # --- Plan cache check ---
    prompt_hash = hashlib.sha256(state["prompt"].strip().lower().encode()).hexdigest()
    db = _get_db(settings)

    cache_result = (
        db.table("plan_cache")
        .select("plan_json")
        .eq("project_id", state["project_id"])
        .eq("prompt_hash", prompt_hash)
        .gt("expires_at", datetime.now(timezone.utc).isoformat())
        .limit(1)
        .execute()
    )

    if cache_result.data:
        plan = cache_result.data[0]["plan_json"]
        is_proposal = plan.get("proposal") and not plan.get("tasks")

        # --- Proposal Approved: Re-run LLM in EXECUTION mode ---
        if is_proposal and state.get("hitl_approved"):
            state["event_seq"] = _emit_event(state, "info", "opus", {"message": "Proposal approved — generating full task list..."}, settings)
            context = _build_context(state)
            proposal_json = json.dumps(plan["proposal"], indent=2)
            messages = [
                {"role": "system", "content": PLANNER_SYSTEM},
                {"role": "user", "content": (
                    f"## Project Context\n{context}\n\n"
                    f"## PROPOSAL APPROVED\nThe following proposal was approved by the user:\n"
                    f"```json\n{proposal_json}\n```\n\n"
                    f"## Original Request\n{state['prompt']}\n\n"
                    f"Generate the full task list (MODE 2: EXECUTION). Keep the proposal object intact."
                )},
            ]
            response = call_llm(ModelTier.OPUS, messages, settings)
            plan = _parse_json_response(response["content"])

            # Update cache with full plan
            db.table("plan_cache").upsert({
                "id": str(uuid4()),
                "tenant_id": state["tenant_id"],
                "project_id": state["project_id"],
                "prompt_hash": prompt_hash,
                "plan_json": plan,
                "tokens_used": response["tokens_in"] + response["tokens_out"],
                "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=settings.plan_cache_ttl_seconds)).isoformat(),
            }, on_conflict="project_id,prompt_hash").execute()

            _log_usage(state, "opus", response["tokens_in"], response["tokens_out"], response["cost"], settings)
            state["event_seq"] = _emit_event(state, "agent_end", "opus", {"agent": "planner", "plan_summary": plan.get("summary", "")}, settings)
        else:
            state["event_seq"] = _emit_event(state, "info", "opus", {"message": "Using cached plan"}, settings)

        # Ingest proposal into Nexus (idempotent upsert)
        _ingest_proposal_to_nexus(plan, state, settings)

        # Still run discriminator even for cached plans
        disc_result = classify_build(
            state["tenant_id"],
            state["project_id"],
            plan,
            state["existing_files"],
            settings,
        )
        if disc_result["overall_mode"] == "genesis":
            plan["needs_scaffold"] = True
        else:
            plan["needs_scaffold"] = False

        _nexus_complete(_nexus_eng, _nexus_eid, "succeeded",
            output_summary=plan.get("summary", "")[:500],
            latency_ms=int((time.monotonic() - _planner_t0) * 1000),
        )
        return {
            "plan": plan,
            "plan_from_cache": True,
            "build_mode": disc_result["overall_mode"],
            "genesis_files": disc_result["genesis_files"],
            "surgical_files": disc_result["surgical_files"],
            "event_seq": state["event_seq"],
        }

    # --- Call Opus ---
    context = _build_context(state)
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM},
        {"role": "user", "content": f"## Project Context\n{context}\n\n## User Request\n{state['prompt']}"},
    ]

    response = call_llm(ModelTier.OPUS, messages, settings)
    plan = _parse_json_response(response["content"])

    # Cache the plan
    db.table("plan_cache").upsert({
        "id": str(uuid4()),
        "tenant_id": state["tenant_id"],
        "project_id": state["project_id"],
        "prompt_hash": prompt_hash,
        "plan_json": plan,
        "tokens_used": response["tokens_in"] + response["tokens_out"],
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=settings.plan_cache_ttl_seconds)).isoformat(),
    }, on_conflict="project_id,prompt_hash").execute()

    _log_usage(state, "opus", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    state["event_seq"] = _emit_event(state, "agent_end", "opus", {"agent": "planner", "plan_summary": plan.get("summary", "")}, settings)

    # --- Early Nexus Ingestion: write proposal to Business Logic Layer ---
    _ingest_proposal_to_nexus(plan, state, settings)

    # --- Emit architectural proposal event for frontend ---
    if plan.get("proposal"):
        state["event_seq"] = _emit_event(
            state, "architectural_proposal", "opus",
            {
                "proposal": plan["proposal"],
                "critical_question": plan.get("critical_question", ""),
                "is_proposal_only": not plan.get("tasks"),
            },
            settings,
        )

    # --- Phase 2: Run discriminator (backend-enforced, not LLM-decided) ---
    disc_result = classify_build(
        state["tenant_id"],
        state["project_id"],
        plan,
        state["existing_files"],
        settings,
    )

    # Override the LLM's needs_scaffold with backend discriminator
    if disc_result["overall_mode"] == "genesis":
        plan["needs_scaffold"] = True
    else:
        plan["needs_scaffold"] = False

    state["event_seq"] = _emit_event(
        state, "info", None,
        {
            "message": f"Discriminator: {disc_result['overall_mode']} mode",
            "genesis_files": disc_result["genesis_files"],
            "surgical_files": disc_result["surgical_files"],
        },
        settings,
    )

    # --- Ledger: record the plan decision ---
    append_decision(
        state["tenant_id"],
        state["project_id"],
        "architecture",
        f"Plan: {plan.get('summary', 'N/A')} | Mode: {disc_result['overall_mode']}",
        settings,
    )

    _nexus_complete(_nexus_eng, _nexus_eid, "succeeded",
        output_summary=plan.get("summary", "")[:500],
        tokens_in=response["tokens_in"],
        tokens_out=response["tokens_out"],
        cost_usd=response["cost"],
        latency_ms=int((time.monotonic() - _planner_t0) * 1000),
    )
    return {
        "plan": plan,
        "plan_from_cache": False,
        "build_mode": disc_result["overall_mode"],
        "genesis_files": disc_result["genesis_files"],
        "surgical_files": disc_result["surgical_files"],
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
        "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
        "total_cost_usd": state["total_cost_usd"] + response["cost"],
        "model_usage": _update_model_usage(state["model_usage"], "opus", response),
    }


# ---------------------------------------------------------------------------
# Node: SCAFFOLDER (DeepSeek — bulk file generation)
# ---------------------------------------------------------------------------

def scaffolder_node(state: BuildState) -> dict:
    """
    Phase 3 — Skeleton-First Protocol:
    1. Architect agent outputs JSON scaffold only
    2. Creates empty files with structure
    3. Enforces: 1 file per generation, max 120 LOC, SoC
    """
    settings = Settings(**state["settings"])
    _update_build_status(state, "scaffolding", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "haiku", {"agent": "scaffolder", "message": "Generating project scaffold..."}, settings)
    _scaff_t0 = time.monotonic()
    _scaff_nexus, _scaff_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "principal_builder", "scaffold", "haiku", settings.model_haiku,
        input_summary=f"Scaffold for: {state.get('prompt', '')[:300]}",
    )

    plan = state["plan"]
    context = _build_context(state)

    messages = [
        {"role": "system", "content": SCAFFOLDER_SYSTEM},
        {"role": "user", "content": (
            f"## Plan\n```json\n{json.dumps(plan, indent=2)}\n```\n\n"
            f"## Context\n{context}\n\n"
            f"## Genesis Files\n{json.dumps(state.get('genesis_files', []))}\n\n"
            "Generate the file tree and base content for the new files.\n"
            "CONSTRAINTS:\n"
            "- Max 120 lines per file\n"
            "- Types only in src/types/ or types.ts\n"
            "- API logic only in src/lib/ or src/services/\n"
            "- Pages are composition only (import + render)\n"
            "- Never mix types + UI + API in one file\n\n"
            "Output JSON: {\"files\": {\"path\": \"content\", ...}}"
        )},
    ]

    response = call_llm(ModelTier.HAIKU, messages, settings)
    files = _parse_json_response(response["content"]).get("files", {})

    # --- Enforce 120 LOC limit ---
    violations = []
    for path, content in files.items():
        loc = len(content.strip().split("\n"))
        if loc > 120:
            violations.append(f"{path}: {loc} LOC (max 120)")

    if violations:
        state["event_seq"] = _emit_event(
            state, "warning", "haiku",
            {"message": "LOC violations in scaffold", "violations": violations},
            settings,
        )

    _log_usage(state, "haiku", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    state["event_seq"] = _emit_event(state, "agent_end", "haiku", {"agent": "scaffolder", "files_created": list(files.keys())}, settings)

    # Emit file contents for frontend preview (SSE file_content events)
    for path, content in files.items():
        state["event_seq"] = _emit_event(
            state, "file_content", "haiku",
            {"path": path, "content": content},
            settings,
        )

    _nexus_complete(_scaff_nexus, _scaff_eid, "succeeded",
        output_summary=f"Scaffolded {len(files)} files: {', '.join(list(files.keys())[:5])}",
        tokens_in=response["tokens_in"],
        tokens_out=response["tokens_out"],
        cost_usd=response["cost"],
        latency_ms=int((time.monotonic() - _scaff_t0) * 1000),
    )
    return {
        "scaffold_files": files,
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
        "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
        "total_cost_usd": state["total_cost_usd"] + response["cost"],
        "model_usage": _update_model_usage(state["model_usage"], "haiku", response),
    }


# ---------------------------------------------------------------------------
# Node: CODER (Sonnet — unified diff patches ONLY)
# ---------------------------------------------------------------------------

def coder_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "coding", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "sonnet", {"agent": "coder", "message": "Generating code patches..."}, settings)
    _coder_t0 = time.monotonic()
    _coder_nexus, _coder_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "principal_builder", "code", "sonnet", settings.model_sonnet,
        input_summary=f"Code patches for: {state.get('prompt', '')[:300]}",
    )

    plan = state["plan"]
    context = _build_context(state)

    # Include review feedback if this is a retry
    review_feedback = ""
    if state.get("review_result") and not state["review_result"].get("approved"):
        findings = state["review_result"].get("findings", [])
        review_feedback = f"\n\n## Review Feedback (must address)\n{json.dumps(findings, indent=2)}"

    # Build scaffold-specific instruction if scaffold files have TODOs
    scaffold_files = state.get('scaffold_files', {})
    scaffold_instruction = ""
    if scaffold_files:
        scaffold_instruction = (
            "\n\n## IMPORTANT — SCAFFOLD COMPLETION\n"
            "The Scaffold Files above were generated by the scaffolder. "
            "If ANY file contains TODO comments, empty function bodies, "
            "placeholder stubs, or missing implementations, you MUST generate "
            "patches that replace them with REAL, WORKING code. Every button "
            "must work, every form must submit, every list must fetch from "
            "the database. Use `window.supabase` for all CRUD operations.\n"
        )

    messages = [
        {"role": "system", "content": CODER_SYSTEM},
        {"role": "user", "content": (
            f"## Plan\n```json\n{json.dumps(plan, indent=2)}\n```\n\n"
            f"## Existing Files\n{_format_files(state['existing_files'])}\n\n"
            f"## Scaffold Files\n{_format_files(scaffold_files)}\n\n"
            f"## Context\n{context}"
            f"{review_feedback}"
            f"{scaffold_instruction}\n\n"
            f"Generate ONLY unified diff patches (git apply compatible). "
            f"Output JSON: {{\"patches\": [\"--- a/file\\n+++ b/file\\n@@ ...\\n...\", ...], \"files_changed\": [\"path\", ...]}}"
        )},
    ]

    try:
        response = call_llm(ModelTier.SONNET, messages, settings)
        result = _parse_json_response(response["content"])
        patches = result.get("patches", [])
    except Exception as _coder_err:
        # LLM call failed (rate-limit, API error, all fallbacks exhausted).
        # Keep whatever patches exist from the previous iteration so the
        # reviewer can evaluate them — at worst the reviewer will reject again
        # and we'll proceed best-effort via review_decision.
        import logging as _logging
        _logging.getLogger(__name__).exception("Coder LLM call failed: %s", _coder_err)
        state["event_seq"] = _emit_event(
            state, "error", "sonnet",
            {"message": f"Coder error (using previous patches): {str(_coder_err)[:200]}"},
            settings,
        )
        patches = state.get("patches", [])
        response = {"tokens_in": 0, "tokens_out": 0, "cost": 0, "content": ""}

    # Phase 2A: Detect SEARCH/REPLACE format and convert to unified diffs
    if not patches and response.get("content") and "===EDIT:" in response["content"]:
        from ..services.search_replace import parse_search_replace_blocks, search_replace_to_diff
        blocks = parse_search_replace_blocks(response["content"])
        if blocks:
            all_files = {**state.get("existing_files", {}), **state.get("scaffold_files", {})}
            patches = search_replace_to_diff(blocks, all_files)
            state["event_seq"] = _emit_event(
                state, "info", "sonnet",
                {"message": f"Converted {len(blocks)} SEARCH/REPLACE blocks to patches"},
                settings,
            )

    for patch in patches:
        state["event_seq"] = _emit_event(state, "patch", "sonnet", {"diff": patch}, settings)

    _log_usage(state, "sonnet", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    state["event_seq"] = _emit_event(state, "agent_end", "sonnet", {"agent": "coder", "patch_count": len(patches)}, settings)

    _nexus_complete(_coder_nexus, _coder_eid, "succeeded",
        output_summary=f"Generated {len(patches)} patches",
        tokens_in=response["tokens_in"],
        tokens_out=response["tokens_out"],
        cost_usd=response["cost"],
        latency_ms=int((time.monotonic() - _coder_t0) * 1000),
    )
    return {
        "patches": patches,
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
        "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
        "total_cost_usd": state["total_cost_usd"] + response["cost"],
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


# ---------------------------------------------------------------------------
# Node: HITL GATE (pause for user approval)
# ---------------------------------------------------------------------------

def hitl_gate_node(state: BuildState) -> dict:
    """HITL checkpoint: pause pipeline and wait for user approval of the plan."""
    # Resume path: plan was already approved via the /approve endpoint.
    # Pass through immediately so hitl_decision routes to scaffolder/coder.
    if state.get("hitl_approved"):
        return {}

    settings = Settings(**state["settings"])
    _update_build_status(state, "awaiting_approval", settings)

    # Save plan to builds table for resume
    db = _get_db(settings)
    db.table("builds").update({
        "plan_json": state["plan"],
        "status": "awaiting_approval",
    }).eq("id", state["build_id"]).execute()

    plan = state["plan"] or {}
    state["event_seq"] = _emit_event(
        state, "info", None,
        {
            "message": "Plan ready for review",
            "hitl_required": True,
            "plan": plan,
            "critical_question": plan.get("critical_question", ""),
            "proposal": plan.get("proposal"),
        },
        settings,
    )

    return {
        "hitl_approved": False,
        "event_seq": state["event_seq"],
    }


# ---------------------------------------------------------------------------
# Node: REVIEWER (Sonnet — QA, security, tests)
# ---------------------------------------------------------------------------

def reviewer_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "reviewing", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "sonnet", {"agent": "reviewer", "message": "Reviewing patches..."}, settings)
    _rev_t0 = time.monotonic()
    _rev_nexus, _rev_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "red_team_sentinel", "review", "sonnet", settings.model_sonnet,
        input_summary=f"Review {len(state.get('patches', []))} patches for: {state.get('prompt', '')[:200]}",
    )

    messages = [
        {"role": "system", "content": REVIEWER_SYSTEM},
        {"role": "user", "content": (
            f"## Patches to Review\n"
            + "\n\n".join(f"```diff\n{p}\n```" for p in state["patches"])
            + f"\n\n## Project Architecture\n{state['architecture_md']}"
            + f"\n\n## API Contracts\n{state['api_contracts_md']}"
            + f"\n\nReview for: correctness, security (OWASP top 10), RLS compliance, "
            f"test coverage gaps, performance issues. "
            f"Output JSON: {{\"approved\": bool, \"findings\": [{{\"severity\": \"critical|warning|info\", \"file\": \"...\", \"description\": \"...\"}}]}}"
        )},
    ]

    try:
        response = call_llm(ModelTier.SONNET, messages, settings)
        review = _parse_json_response(response["content"])
    except Exception as _rev_err:
        # Reviewer LLM call failed — approve best-effort so the build can
        # proceed to the committer rather than looping or crashing entirely.
        import logging as _logging
        _logging.getLogger(__name__).exception("Reviewer LLM call failed: %s", _rev_err)
        state["event_seq"] = _emit_event(
            state, "warning", "sonnet",
            {"message": f"Reviewer error — approving best-effort: {str(_rev_err)[:200]}"},
            settings,
        )
        review = {
            "approved": True,
            "findings": [{"severity": "warning", "file": "N/A",
                          "description": f"Reviewer unavailable: {str(_rev_err)[:200]}"}],
        }
        response = {"tokens_in": 0, "tokens_out": 0, "cost": 0, "content": ""}

    _log_usage(state, "sonnet", response["tokens_in"], response["tokens_out"], response["cost"], settings)

    for finding in review.get("findings", []):
        state["event_seq"] = _emit_event(state, "warning" if finding.get("severity") != "critical" else "error", "sonnet", finding, settings)

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {"agent": "reviewer", "approved": review.get("approved", False), "finding_count": len(review.get("findings", []))},
        settings,
    )

    _approved = review.get("approved", False)
    _nexus_complete(_rev_nexus, _rev_eid,
        status="succeeded" if _approved else "rejected",
        output_summary=f"{'Approved' if _approved else 'Rejected'}: {len(review.get('findings', []))} findings",
        tokens_in=response["tokens_in"],
        tokens_out=response["tokens_out"],
        cost_usd=response["cost"],
        latency_ms=int((time.monotonic() - _rev_t0) * 1000),
    )
    return {
        "review_result": review,
        "review_iterations": state["review_iterations"] + 1,
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
        "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
        "total_cost_usd": state["total_cost_usd"] + response["cost"],
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


# ---------------------------------------------------------------------------
# Node: COMMITTER (apply patches, git commit, build image)
# ---------------------------------------------------------------------------

def committer_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "building", settings)
    state["event_seq"] = _emit_event(state, "build_progress", None, {"message": "Applying patches and building image..."}, settings)
    _comm_t0 = time.monotonic()
    _comm_nexus, _comm_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "staff_engineer", "commit", "none", "none",
        input_summary=f"Apply {len(state.get('patches', []))} patches, run sentinel",
    )

    from ..pipeline.builder import apply_and_build

    try:
        result = apply_and_build(
            tenant_id=state["tenant_id"],
            project_id=state["project_id"],
            build_id=state["build_id"],
            scaffold_files=state.get("scaffold_files", {}),
            patches=state["patches"],
            prompt=state["prompt"],
            model_usage=state["model_usage"],
            settings=settings,
        )
    except Exception as _build_err:
        import logging as _logging
        _logging.getLogger(__name__).exception("apply_and_build failed: %s", _build_err)
        state["event_seq"] = _emit_event(
            state, "error", None,
            {"message": f"Build step failed: {str(_build_err)[:300]}"},
            settings,
        )
        _update_build_status(state, "failed", settings)
        _nexus_complete(_comm_nexus, _comm_eid, "failed",
            output_summary=f"apply_and_build error: {str(_build_err)[:200]}",
            latency_ms=int((time.monotonic() - _comm_t0) * 1000),
        )
        return {
            "commit_sha": "",
            "image_tag": "",
            "sentinel_result": None,
            "event_seq": state["event_seq"],
        }

    # --- Emit final file contents for frontend preview ---
    final_files = result.get("final_files", {})
    if final_files:
        for path, content in final_files.items():
            state["event_seq"] = _emit_event(
                state, "file_content", "sonnet",
                {"path": path, "content": content},
                settings,
            )

    # --- Phase 6: Sentinel auto-heal loop ---
    sentinel_result = None
    if result.get("repo_dir"):
        state["event_seq"] = _emit_event(
            state, "info", None,
            {"message": "Running sentinel auto-heal..."},
            settings,
        )
        from pathlib import Path
        sentinel_result = run_sentinel(
            Path(result["repo_dir"]),
            settings,
            call_llm_fn=call_llm,
        )
        state["event_seq"] = _emit_event(
            state, "info", None,
            {
                "message": f"Sentinel: {'clean' if sentinel_result.get('clean') else 'issues remain'}",
                "errors_fixed": sentinel_result.get("errors_fixed", 0),
            },
            settings,
        )

    # --- Phase 1C: Feed sentinel findings into Neural Nexus ---
    if sentinel_result:
        try:
            from ..nexus.engine import NexusEngine
            nexus = NexusEngine(settings)

            for error_msg in sentinel_result.get("remaining_errors", []):
                file_path = _extract_file_from_error(error_msg)
                if file_path:
                    nexus.tag_tech_debt(
                        project_id=state["project_id"],
                        file=file_path,
                        severity="medium" if "warning" in error_msg.lower() else "high",
                        description=error_msg[:200],
                        tagged_by="sentinel",
                    )

            _remaining = len(sentinel_result.get("remaining_errors", []))
            _sentinel_summary = "clean" if sentinel_result.get("clean") else f"{_remaining} errors remain"
            nexus.record_feedback(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                user_id=state.get("user_id", "system"),
                event_type="tech_debt_tagged",
                feedback={
                    "clean": sentinel_result.get("clean", False),
                    "errors_fixed": sentinel_result.get("errors_fixed", 0),
                    "remaining_count": _remaining,
                },
                agent="red_team_sentinel",
                prompt=state["prompt"],
                response_summary=f"Sentinel: {_sentinel_summary}",
            )
        except Exception as nexus_err:
            import logging
            logging.getLogger(__name__).warning("Sentinel->Nexus feedback failed: %s", nexus_err)

    # --- AST graph: rebuild and persist after patches ---
    all_files = {**state.get("existing_files", {}), **state.get("scaffold_files", {})}
    if all_files:
        graph = build_dependency_graph(all_files)
        persist_graph(state["tenant_id"], state["project_id"], graph, settings)

    # --- Phase 2B: Index components for RAG ---
    if all_files:
        try:
            from ..services.component_rag import index_components
            indexed = index_components(
                state["tenant_id"], state["project_id"], all_files, settings
            )
            if indexed:
                state["event_seq"] = _emit_event(
                    state, "info", None,
                    {"message": f"Indexed {indexed} components for RAG"},
                    settings,
                )
        except Exception as rag_err:
            import logging
            logging.getLogger(__name__).warning("Component indexing failed: %s", rag_err)

    # --- Store file summaries for vector memory ---
    for path, content in state.get("scaffold_files", {}).items():
        first_line = content.split("\n")[0][:200] if content else ""
        store_file_summary(
            state["tenant_id"], state["project_id"],
            path, f"File: {path} — {first_line}",
            settings,
        )

    state["event_seq"] = _emit_event(
        state, "build_progress", None,
        {"message": "Build complete", "commit_sha": result["commit_sha"], "image_tag": result["image_tag"]},
        settings,
    )

    _nexus_complete(_comm_nexus, _comm_eid, "succeeded",
        output_summary=f"Committed {result.get('commit_sha', '')[:8]}, sentinel: {'clean' if not sentinel_result or sentinel_result.get('clean') else 'issues'}",
        latency_ms=int((time.monotonic() - _comm_t0) * 1000),
    )
    return {
        "commit_sha": result["commit_sha"],
        "image_tag": result["image_tag"],
        "sentinel_result": sentinel_result,
        "event_seq": state["event_seq"],
    }


# ---------------------------------------------------------------------------
# Node: DEPLOYER (deploy image, get preview URL)
# ---------------------------------------------------------------------------

def deployer_node(state: BuildState) -> dict:
    # If the committer already failed (commit_sha is empty), skip deployment
    # so we don't overwrite the "failed" build status it already set.
    if not state.get("commit_sha"):
        return {"event_seq": state.get("event_seq", 0)}

    settings = Settings(**state["settings"])
    _update_build_status(state, "deploying", settings)
    state["event_seq"] = _emit_event(state, "deploy_progress", None, {"message": "Deploying to preview..."}, settings)
    _dep_t0 = time.monotonic()
    _dep_nexus, _dep_eid = _nexus_start(
        settings, state["tenant_id"], state["project_id"], state["build_id"],
        "devops_lead", "deploy", "none", "none",
        input_summary=f"Deploy image {state.get('image_tag', 'unknown')}",
    )

    from ..pipeline.deployer import deploy_preview

    try:
        result = deploy_preview(
            tenant_id=state["tenant_id"],
            project_id=state["project_id"],
            build_id=state["build_id"],
            image_tag=state["image_tag"],
            settings=settings,
        )
    except Exception as _deploy_err:
        import logging as _logging
        _logging.getLogger(__name__).exception("deploy_preview failed (non-fatal): %s", _deploy_err)
        # Deploy failure should not fail the build — the code was successfully generated and
        # committed. Use a fallback storage-based preview URL so the build can still succeed.
        result = {"preview_url": f"https://{state['build_id'][:8]}.{settings.preview_domain}"}
        state["event_seq"] = _emit_event(
            state, "warning", None,
            {"message": f"Deploy step failed (build still succeeded): {str(_deploy_err)[:200]}"},
            settings,
        )

    state["event_seq"] = _emit_event(
        state, "deploy_progress", None,
        {"message": "Deploy complete", "preview_url": result["preview_url"]},
        settings,
    )

    # --- Phase 3C: Refresh observability metrics ---
    try:
        from ..services.observability import compute_build_stats
        compute_build_stats(state["tenant_id"], state["project_id"], settings)
    except Exception:
        pass

    # Mark build as succeeded
    db = _get_db(settings)
    db.table("builds").update({
        "status": "succeeded",
        "commit_sha": state["commit_sha"],
        "image_tag": state["image_tag"],
        "patches": state["patches"],
        "files_changed": list(set(
            f for p in state["patches"] for f in _extract_files_from_patch(p)
        )),
        "model_usage": state["model_usage"],
        "total_tokens_in": state["total_tokens_in"],
        "total_tokens_out": state["total_tokens_out"],
        "total_cost_usd": state["total_cost_usd"],
        "completed_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", state["build_id"]).execute()

    # --- Sync Project State Matrix (PSM) with final built files ---
    try:
        all_final_files = {**state.get("existing_files", {}), **state.get("scaffold_files", {})}
        if all_final_files and _dep_nexus:
            _dep_nexus.update_file_graph(state["tenant_id"], state["project_id"], all_final_files)
    except Exception as _psm_err:
        logger.warning("Nexus PSM sync failed (non-critical): %s", _psm_err)

    # --- Feed successful build into Nexus flywheel ---
    try:
        if _dep_nexus:
            files_changed = list(set(
                f for p in state.get("patches", []) for f in _extract_files_from_patch(p)
            ))
            _dep_nexus.record_feedback(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                user_id=state.get("user_id", "system"),
                event_type="code_accepted",
                feedback={
                    "files_changed": files_changed,
                    "patch_count": len(state.get("patches", [])),
                    "commit_sha": state.get("commit_sha"),
                    "deploy_url": result.get("preview_url"),
                    "total_cost_usd": state.get("total_cost_usd", 0),
                },
                agent="principal_builder",
                prompt=state.get("prompt", ""),
                response_summary=f"Built {len(files_changed)} files, deployed to {result.get('preview_url', 'unknown')}",
            )
    except Exception as _fb_err:
        logger.warning("Nexus feedback record failed (non-critical): %s", _fb_err)

    _nexus_complete(_dep_nexus, _dep_eid, "succeeded",
        output_summary=f"Deployed to {result.get('preview_url', 'unknown')}",
        latency_ms=int((time.monotonic() - _dep_t0) * 1000),
    )
    return {
        "deploy_url": result["preview_url"],
        "event_seq": state["event_seq"],
    }


# ---------------------------------------------------------------------------
# Conditional edges
# ---------------------------------------------------------------------------

def should_scaffold(state: BuildState) -> str:
    """Route to scaffolder if plan indicates new project or significant new files."""
    plan = state.get("plan", {})
    if plan.get("needs_scaffold", False):
        return "scaffolder"
    return "coder"


def review_decision(state: BuildState) -> str:
    """After review: if approved -> commit; if rejected and under max iterations -> coder; else -> commit (best-effort).

    Severity-gated rejection to prevent warning-level issues from spinning 5 loops:
    - Iterations 1-2: Reject on any non-approved review (strict)
    - Iterations 3+:  Only reject if CRITICAL findings remain (not warnings/info)
    """
    settings = Settings(**state["settings"])
    review = state.get("review_result", {})

    if review.get("approved", False):
        return "committer"

    # After iteration 2, only block on critical findings — not warnings
    if state["review_iterations"] >= 3:
        findings = review.get("findings", [])
        critical_findings = [f for f in findings if f.get("severity") == "critical"]
        if not critical_findings:
            # No critical issues — warnings are acceptable; proceed to commit
            _emit_event(state, "info", None, {
                "message": f"No critical findings after iteration {state['review_iterations']} — proceeding with warnings noted."
            }, settings)
            return "committer"

    if state["review_iterations"] < settings.max_agent_iterations:
        _emit_event(state, "info", None, {"message": f"Review rejected (iteration {state['review_iterations']}), retrying coder..."}, settings)
        return "coder"

    # Max iterations reached — proceed with best effort
    _emit_event(state, "warning", None, {"message": f"Max review iterations ({settings.max_agent_iterations}) reached. Proceeding with best-effort code."}, settings)
    return "committer"


# ---------------------------------------------------------------------------
# Node: REQUIREMENTS (GPT-4o — natural language → structured PRD)
# ---------------------------------------------------------------------------

def requirements_node(state: BuildState) -> dict:
    """Stage 0: Convert user prompt → structured PRD using GPT-4o."""
    settings = Settings(**state["settings"])

    # Skip if: stage disabled, requirements already set, or already approved (resume path)
    if (not settings.enable_requirements_stage
            or state.get("requirements")
            or state.get("requirements_approved")):
        return {"build_phase": "design"}

    state["event_seq"] = _emit_event(
        state, "agent_start", "gpt4o",
        {"agent": "requirements", "message": "Analyzing requirements with GPT-4o..."},
        settings,
    )

    figma_context = ""
    if state.get("figma_key"):
        figma_context = f"\n\nThe user has provided a Figma file key: {state['figma_key']}. Reference screen names from the design."

    messages = [
        {"role": "system", "content": REQUIREMENTS_SYSTEM},
        {"role": "user", "content": (
            f"Convert this product idea into a structured PRD:\n\n"
            f"{state['prompt']}"
            f"{figma_context}"
        )},
    ]

    try:
        response = call_llm(ModelTier.GPT4O, messages, settings, max_tokens=4096)
        requirements = _parse_json_response(response["content"])
        _log_usage(state, "gpt4o", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _req_err:
        logging.getLogger(__name__).warning("Requirements agent failed, falling back to planner: %s", _req_err)
        state["event_seq"] = _emit_event(
            state, "warning", None,
            {"message": f"Requirements analysis unavailable ({type(_req_err).__name__}: {str(_req_err)[:200]}). Continuing with prompt directly."},
            settings,
        )
        return {"build_phase": "design", "requirements": None, "event_seq": state["event_seq"]}

    state["event_seq"] = _emit_event(
        state, "agent_end", "gpt4o",
        {
            "agent": "requirements",
            "app_name": requirements.get("app_name", ""),
            "screens": len(requirements.get("screens", [])),
            "entities": len(requirements.get("data_entities", [])),
            "requirements": requirements,
            "hitl_required": True,
        },
        settings,
    )

    return {
        "requirements": requirements,
        "requirements_approved": False,
        "build_phase": "requirements",
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "gpt4o", response),
    }


def requirements_hitl_node(state: BuildState) -> dict:
    """HITL Gate A: pause after requirements for user review."""
    if state.get("requirements_approved") or not state.get("requirements"):
        return {}  # Pass through

    settings = Settings(**state["settings"])
    _update_build_status(state, "awaiting_requirements_approval", settings)

    db = _get_db(settings)
    db.table("builds").update({"status": "awaiting_requirements_approval"}).eq("id", state["build_id"]).execute()

    state["event_seq"] = _emit_event(
        state, "info", None,
        {
            "message": "Requirements ready for review",
            "hitl_required": True,
            "gate": "requirements",
            "requirements": state["requirements"],
        },
        settings,
    )
    return {"requirements_approved": False, "event_seq": state["event_seq"]}


def requirements_hitl_decision(state: BuildState) -> str:
    """Route after requirements HITL."""
    if state.get("requirements_approved") or not state.get("requirements"):
        return "design"
    return "__end__"


# ---------------------------------------------------------------------------
# Node: DESIGN (Figma API or Sonnet — design contract generation)
# ---------------------------------------------------------------------------

def design_node(state: BuildState) -> dict:
    """Stage 1: Generate Design Contract from Figma JSON or PRD."""
    settings = Settings(**state["settings"])

    # Try Figma first if key is provided and stage is enabled
    figma_contract = None
    if settings.enable_figma_stage and state.get("figma_key"):
        try:
            from ..services.figma import fetch_design_contract
            figma_contract = fetch_design_contract(state["figma_key"], settings)
            state["event_seq"] = _emit_event(
                state, "info", "figma",
                {
                    "message": f"Figma design loaded: {figma_contract['file_name']} ({len(figma_contract['screens'])} screens)",
                    "design_contract": figma_contract,
                },
                settings,
            )
        except Exception as _figma_err:
            logging.getLogger(__name__).warning("Figma fetch failed, generating design from PRD: %s", _figma_err)

    if figma_contract:
        return {
            "design_contract": figma_contract,
            "design_approved": True,  # Figma designs auto-approved (user already approved in Figma)
            "build_phase": "frontend",
            "event_seq": state["event_seq"],
        }

    # No Figma — generate design spec from PRD using Sonnet
    state["event_seq"] = _emit_event(
        state, "agent_start", "sonnet",
        {"agent": "design", "message": "Generating design contract from requirements..."},
        settings,
    )

    requirements_ctx = json.dumps(state.get("requirements") or {"prompt": state["prompt"]}, indent=2)
    messages = [
        {"role": "system", "content": DESIGN_SYSTEM},
        {"role": "user", "content": f"Generate a Design Contract for this product:\n\n{requirements_ctx}"},
    ]

    try:
        # GPT-4o: Layer 1 Communicator — reliable structured JSON output for design specs
        response = call_llm(ModelTier.GPT4O, messages, settings, max_tokens=4096)
        design_contract = _parse_json_response(response["content"])
        _log_usage(state, "gpt4o", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _design_err:
        logging.getLogger(__name__).warning("Design agent failed, proceeding without: %s", _design_err)
        return {"design_contract": None, "design_approved": True, "build_phase": "frontend"}

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {"agent": "design", "design_contract": design_contract},
        settings,
    )

    return {
        "design_contract": design_contract,
        "design_approved": False,
        "build_phase": "design",
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


# ---------------------------------------------------------------------------
# Node: FRONTEND (Sonnet — complete UI with mock data, no backend)
# ---------------------------------------------------------------------------

def frontend_node(state: BuildState) -> dict:
    """Stage 2: Build complete frontend with mock data (no Supabase calls)."""
    settings = Settings(**state["settings"])
    _update_build_status(state, "building_frontend", settings)

    state["event_seq"] = _emit_event(
        state, "agent_start", "sonnet",
        {"agent": "frontend", "message": "Building frontend UI (mock data, no backend)..."},
        settings,
    )

    requirements_ctx = json.dumps(state.get("requirements") or {"prompt": state["prompt"]}, indent=2)
    design_ctx = json.dumps(state.get("design_contract") or {}, indent=2)

    messages = [
        {"role": "system", "content": FRONTEND_SYSTEM},
        {"role": "user", "content": (
            f"## Product Requirements\n{requirements_ctx}\n\n"
            f"## Design Contract\n{design_ctx}\n\n"
            f"## User Request\n{state['prompt']}\n\n"
            f"Build the complete frontend. ALL screens. ALL components. Mock data only."
        )},
    ]

    try:
        # Gemini Pro: Layer 2 Analyst — 1M context + vision, generates large code volumes
        response = call_llm(ModelTier.GEMINI_PRO, messages, settings, max_tokens=16000)
        result = _parse_json_response(response["content"])
        frontend_files = result.get("files", {})
        _log_usage(state, "gemini_pro", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _fe_err:
        logging.getLogger(__name__).exception("Frontend node failed: %s", _fe_err)
        state["event_seq"] = _emit_event(
            state, "error", None,
            {"message": f"Frontend build failed ({type(_fe_err).__name__}): {str(_fe_err)[:300]}. Check GEMINI_API_KEY and model name in Railway env vars."},
            settings,
        )
        return {"build_phase": "frontend", "event_seq": state["event_seq"]}

    if not frontend_files:
        state["event_seq"] = _emit_event(
            state, "warning", None,
            {"message": "Frontend node returned no files. Gemini response may not have included a 'files' JSON key. Check Railway logs for raw response."},
            settings,
        )
        return {"build_phase": "frontend", "event_seq": state["event_seq"]}

    # Emit frontend files for preview
    for path, content in frontend_files.items():
        state["event_seq"] = _emit_event(
            state, "file_content", "sonnet",
            {"path": path, "content": content, "stage": "frontend"},
            settings,
        )

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {
            "agent": "frontend",
            "files_count": len(frontend_files),
            "screens": result.get("screens_built", []),
            "hitl_required": True,
            "gate": "frontend",
        },
        settings,
    )

    return {
        "frontend_files": frontend_files,
        "frontend_approved": False,
        "build_phase": "frontend",
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


def frontend_hitl_node(state: BuildState) -> dict:
    """HITL Gate C: pause after frontend build for visual approval."""
    if state.get("frontend_approved"):
        return {}

    settings = Settings(**state["settings"])
    _update_build_status(state, "awaiting_frontend_approval", settings)

    db = _get_db(settings)
    db.table("builds").update({"status": "awaiting_frontend_approval"}).eq("id", state["build_id"]).execute()

    state["event_seq"] = _emit_event(
        state, "info", None,
        {
            "message": "Frontend ready for visual review",
            "hitl_required": True,
            "gate": "frontend",
            "files": list(state.get("frontend_files", {}).keys()),
        },
        settings,
    )
    return {"frontend_approved": False, "event_seq": state["event_seq"]}


def frontend_hitl_decision(state: BuildState) -> str:
    """Route after frontend HITL."""
    if state.get("frontend_approved"):
        return "backend_spec"
    return "__end__"


# ---------------------------------------------------------------------------
# Node: BACKEND SPEC (Sonnet — reverse-engineer backend from frontend)
# ---------------------------------------------------------------------------

def backend_spec_node(state: BuildState) -> dict:
    """Stage 3: Analyze frontend code and generate backend schema spec."""
    settings = Settings(**state["settings"])

    state["event_seq"] = _emit_event(
        state, "agent_start", "sonnet",
        {"agent": "backend_spec", "message": "Analyzing frontend to generate backend schema..."},
        settings,
    )

    frontend_code = "\n\n".join(
        f"// File: {path}\n{content}"
        for path, content in (state.get("frontend_files") or {}).items()
    )

    messages = [
        {"role": "system", "content": BACKEND_SPEC_SYSTEM},
        {"role": "user", "content": (
            f"## Approved Frontend Code\n{frontend_code[:30000]}\n\n"
            f"Analyze this frontend and generate the exact backend spec it needs."
        )},
    ]

    try:
        # Gemini Pro: Layer 2 Analyst — 1M context sees full codebase for accurate backend spec
        response = call_llm(ModelTier.GEMINI_PRO, messages, settings, max_tokens=4096)
        backend_spec = _parse_json_response(response["content"])
        _log_usage(state, "gemini_pro", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _bs_err:
        logging.getLogger(__name__).exception("Backend spec node failed: %s", _bs_err)
        return {"backend_spec": None, "build_phase": "backend", "event_seq": state["event_seq"]}

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {
            "agent": "backend_spec",
            "collections": [c["name"] for c in backend_spec.get("collections", [])],
            "backend_spec": backend_spec,
        },
        settings,
    )

    return {
        "backend_spec": backend_spec,
        "build_phase": "backend",
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


# ---------------------------------------------------------------------------
# Node: INTEGRATION (Sonnet — wire frontend mocks to real Supabase)
# ---------------------------------------------------------------------------

def integration_node(state: BuildState) -> dict:
    """Stage 4: Replace mock hooks with real Supabase calls."""
    settings = Settings(**state["settings"])
    _update_build_status(state, "integrating", settings)

    state["event_seq"] = _emit_event(
        state, "agent_start", "sonnet",
        {"agent": "integration", "message": "Wiring frontend to Supabase backend..."},
        settings,
    )

    frontend_code = "\n\n".join(
        f"// File: {path}\n{content}"
        for path, content in (state.get("frontend_files") or {}).items()
    )
    backend_spec_ctx = json.dumps(state.get("backend_spec") or {}, indent=2)

    messages = [
        {"role": "system", "content": INTEGRATION_SYSTEM},
        {"role": "user", "content": (
            f"## Approved Frontend Code\n{frontend_code[:25000]}\n\n"
            f"## Backend Spec\n{backend_spec_ctx}\n\n"
            f"Replace ALL mock hooks with real Supabase calls. "
            f"Return unified diff patches."
        )},
    ]

    try:
        response = call_llm(ModelTier.SONNET, messages, settings, max_tokens=12000)
        result = _parse_json_response(response["content"])
        patches = result.get("patches", [])
        _log_usage(state, "sonnet", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _int_err:
        logging.getLogger(__name__).exception("Integration node failed: %s", _int_err)
        # Fall back to using frontend files directly as scaffold
        scaffold_files = state.get("frontend_files", {})
        return {
            "scaffold_files": scaffold_files,
            "patches": [],
            "build_phase": "integration",
            "event_seq": state["event_seq"],
        }

    for patch in patches:
        state["event_seq"] = _emit_event(state, "patch", "sonnet", {"diff": patch}, settings)

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {"agent": "integration", "patch_count": len(patches)},
        settings,
    )

    return {
        "scaffold_files": state.get("frontend_files", {}),
        "patches": patches,
        "build_phase": "integration",
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "sonnet", response),
    }


# ---------------------------------------------------------------------------
# Node: PRE-REVIEWER (Gemini Flash — fast critical-issue gate)
# ---------------------------------------------------------------------------

def pre_reviewer_node(state: BuildState) -> dict:
    """Gemini Flash fast pre-review: blocks only critical security/data issues.

    Runs before expensive Sonnet reviewer. 40x cheaper, <2s.
    Only blocks on showstoppers (XSS, data leakage, hardcoded credentials).
    Warnings go directly to commit without burning a review iteration.
    """
    settings = Settings(**state["settings"])

    if not settings.enable_gemini_pre_review or not settings.gemini_api_key:
        return {}  # Skip if not configured

    patches_text = "\n\n".join(state.get("patches", []))
    if not patches_text:
        return {}

    messages = [
        {"role": "system", "content": PRE_REVIEW_SYSTEM},
        {"role": "user", "content": (
            f"Scan these patches for critical issues:\n\n"
            f"```diff\n{patches_text[:20000]}\n```"
        )},
    ]

    try:
        response = call_llm(ModelTier.GEMINI_FLASH, messages, settings, max_tokens=1024)
        pre_review = _parse_json_response(response["content"])
        _log_usage(state, "gemini_flash", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _pr_err:
        logging.getLogger(__name__).warning("Pre-reviewer failed (skipping): %s", _pr_err)
        return {}  # Fail open — don't block on pre-reviewer failure

    blocking = pre_review.get("blocking_issues", [])
    if blocking:
        state["event_seq"] = _emit_event(
            state, "warning", "gemini_flash",
            {"message": f"Pre-review: {len(blocking)} critical issue(s) found", "issues": blocking},
            settings,
        )
        # Inject pre-review findings into review_result so coder sees them immediately
        return {
            "review_result": {"approved": False, "findings": blocking},
            "review_iterations": state.get("review_iterations", 0) + 1,
            "event_seq": state["event_seq"],
            "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
            "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
            "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
            "model_usage": _update_model_usage(state["model_usage"], "gemini_flash", response),
        }

    # No critical issues — pass straight to commit (skip expensive Sonnet review)
    state["event_seq"] = _emit_event(
        state, "info", "gemini_flash",
        {"message": "Pre-review: clean — no critical issues found"},
        settings,
    )
    return {
        "review_result": {"approved": True, "findings": pre_review.get("notes", [])},
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "gemini_flash", response),
    }


def pre_review_decision(state: BuildState) -> str:
    """After pre-review: if clean -> commit; if blocking -> coder."""
    review = state.get("review_result", {})
    if review.get("approved", True):
        return "committer"
    return "coder"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Node: COMMENTARY (GPT-4o Layer 1 — translate technical plan → user message)
# ---------------------------------------------------------------------------

def commentary_node(state: BuildState) -> dict:
    """
    GPT-4o Layer 1 Communicator: runs before every HITL gate.
    Translates technical JSON plans into a friendly, actionable user message.

    Receives whatever is the most recent significant artifact:
    - requirements PRD (after Stage 0)
    - plan + proposal (after Opus planner)
    - frontend_files summary (after Stage 2)

    Emits a 'commentary' event that the frontend surfaces directly to the user
    instead of showing raw JSON.
    """
    settings = Settings(**state["settings"])

    # Build context from the most recent stage artifact
    gate = state.get("build_phase", "requirements")
    if gate == "requirements" and state.get("requirements"):
        artifact_label = "Product Requirements"
        artifact = json.dumps(state["requirements"], indent=2)[:6000]
    elif state.get("plan"):
        artifact_label = "Architecture Plan"
        plan = state["plan"]
        artifact = json.dumps({
            "summary": plan.get("summary", ""),
            "proposal": plan.get("proposal"),
            "critical_question": plan.get("critical_question", ""),
            "screens": plan.get("proposal", {}).get("screens", []) if plan.get("proposal") else [],
        }, indent=2)[:4000]
    elif state.get("frontend_files"):
        artifact_label = "Frontend Build"
        screens = list(state["frontend_files"].keys())
        artifact = f"Built {len(screens)} files: {', '.join(screens[:8])}"
    else:
        return {}  # Nothing to narrate

    messages = [
        {"role": "system", "content": COMMENTARY_SYSTEM},
        {"role": "user", "content": (
            f"## {artifact_label}\n{artifact}\n\n"
            f"Write a friendly 3-5 sentence explanation for the user. "
            f"Original user request: \"{state.get('prompt', '')[:300]}\""
        )},
    ]

    try:
        # GPT-4o: Layer 1 Communicator — user-facing narrative
        response = call_llm(ModelTier.GPT4O, messages, settings, max_tokens=400)
        commentary = response["content"].strip()
        _log_usage(state, "gpt4o", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    except Exception as _c_err:
        logging.getLogger(__name__).warning("Commentary node failed (non-blocking): %s", _c_err)
        return {}  # Commentary is optional — never block the pipeline

    state["event_seq"] = _emit_event(
        state, "info", "gpt4o",
        {
            "agent": "commentary",
            "message": commentary,
            "gate": gate,
            "is_user_message": True,
        },
        settings,
    )

    return {
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response.get("tokens_in", 0),
        "total_tokens_out": state["total_tokens_out"] + response.get("tokens_out", 0),
        "total_cost_usd": state["total_cost_usd"] + response.get("cost", 0),
        "model_usage": _update_model_usage(state["model_usage"], "gpt4o", response),
    }


def hitl_decision(state: BuildState) -> str:
    """After hitl_gate: if approved -> frontend_node (genesis) / coder (surgical); if not -> end (wait)."""
    if not state.get("hitl_approved"):
        return "__end__"

    settings = Settings(**state["settings"])
    plan = state.get("plan", {}) or {}

    # Frontend-first mode: any genesis build — requirements are optional bonus context
    if settings.enable_frontend_first and plan.get("needs_scaffold", False):
        return "frontend"

    # Legacy path: scaffolder + coder (genesis with frontend_first disabled)
    if plan.get("needs_scaffold", False):
        return "scaffolder"

    # Surgical mode: direct to coder
    return "coder"


def build_graph() -> StateGraph:
    """Construct the three-layer multi-modal LangGraph agent pipeline.

    Three-layer model assignment:
      GPT-4o   (Layer 1 Communicator) — requirements, design spec, HITL commentary
      Gemini   (Layer 2 Analyst)      — frontend code, backend spec, codebase context, pre-review
      Claude   (Layer 3 Engineer)     — integration patches, security review, repair, planning

    New flow (frontend-first):
      requirements → commentary_req → requirements_hitl
        → design → planner → commentary_plan → hitl_gate
        → frontend → commentary_fe → frontend_hitl
        → backend_spec → integration → pre_reviewer → reviewer → committer → deployer

    Legacy flow (surgical):
      requirements(skip) → design(skip) → planner → commentary_plan → hitl_gate
        → coder → pre_reviewer → reviewer → committer → deployer
    """
    graph = StateGraph(BuildState)

    # ── Layer 1: GPT-4o commentary (one node, used 3 times with aliases) ──
    graph.add_node("commentary_req",  commentary_node)  # Before requirements HITL
    graph.add_node("commentary_plan", commentary_node)  # Before architecture HITL
    graph.add_node("commentary_fe",   commentary_node)  # Before frontend HITL

    # ── Stage 0: Requirements (GPT-4o) ────────────────────────────────────
    graph.add_node("requirements",     requirements_node)
    graph.add_node("requirements_hitl", requirements_hitl_node)

    # ── Stage 1: Design Contract (GPT-4o) ────────────────────────────────
    graph.add_node("design", design_node)

    # ── Stage 2a: Architecture Planning (Opus) + HITL ────────────────────
    graph.add_node("planner",   planner_node)
    graph.add_node("hitl_gate", hitl_gate_node)

    # ── Stage 2b: Frontend-first genesis path ────────────────────────────
    graph.add_node("frontend",      frontend_node)       # Gemini Pro
    graph.add_node("frontend_hitl", frontend_hitl_node)
    graph.add_node("backend_spec",  backend_spec_node)   # Gemini Pro
    graph.add_node("integration",   integration_node)    # Claude Sonnet

    # ── Legacy path ───────────────────────────────────────────────────────
    graph.add_node("scaffolder", scaffolder_node)        # Claude Haiku

    # ── Shared code path ──────────────────────────────────────────────────
    graph.add_node("coder",        coder_node)           # Claude Sonnet
    graph.add_node("pre_reviewer", pre_reviewer_node)    # Gemini Flash
    graph.add_node("reviewer",     reviewer_node)        # Claude Sonnet
    graph.add_node("committer",    committer_node)
    graph.add_node("deployer",     deployer_node)

    # ── ENTRY → Requirements → Commentary → HITL ─────────────────────────
    graph.set_entry_point("requirements")
    graph.add_edge("requirements", "commentary_req")
    graph.add_edge("commentary_req", "requirements_hitl")
    graph.add_conditional_edges("requirements_hitl", requirements_hitl_decision, {
        "design": "design",
        "__end__": END,
    })

    # ── Design → Planner → Commentary → HITL ─────────────────────────────
    graph.add_edge("design", "planner")
    graph.add_edge("planner", "commentary_plan")
    graph.add_edge("commentary_plan", "hitl_gate")
    graph.add_conditional_edges("hitl_gate", hitl_decision, {
        "frontend":   "frontend",    # Frontend-first genesis
        "scaffolder": "scaffolder",  # Legacy genesis
        "coder":      "coder",       # Surgical mode
        "__end__":    END,
    })

    # ── Frontend-first: Frontend → Commentary → HITL → Backend → Integrate ─
    graph.add_edge("frontend", "commentary_fe")
    graph.add_edge("commentary_fe", "frontend_hitl")
    graph.add_conditional_edges("frontend_hitl", frontend_hitl_decision, {
        "backend_spec": "backend_spec",
        "__end__": END,
    })
    graph.add_edge("backend_spec", "integration")
    graph.add_edge("integration", "pre_reviewer")

    # ── Legacy path ───────────────────────────────────────────────────────
    graph.add_edge("scaffolder", "coder")
    graph.add_edge("coder", "pre_reviewer")

    # ── Pre-review gate (Gemini Flash — fast critical check) ──────────────
    graph.add_conditional_edges("pre_reviewer", pre_review_decision, {
        "committer": "committer",   # Clean: skip expensive Sonnet review
        "coder": "reviewer",        # Issues found: run full Sonnet review
    })

    # ── Full review loop (Sonnet) ─────────────────────────────────────────
    graph.add_conditional_edges("reviewer", review_decision, {
        "coder": "coder",
        "committer": "committer",
    })

    # ── Commit + deploy ───────────────────────────────────────────────────
    graph.add_edge("committer", "deployer")
    graph.add_edge("deployer", END)

    return graph


# ---------------------------------------------------------------------------
# Entry point — called from FastAPI background task
# ---------------------------------------------------------------------------

async def run_build(
    build_id: str,
    tenant_id: str,
    project_id: str,
    prompt: str,
    settings: Settings,
):
    """Run the full agent pipeline for a build."""
    db = _get_db(settings)

    # Ensure app_data table exists (for Universal Table strategy)
    _ensure_app_data_table(db, settings)

    # Load project memory files
    project = (
        db.table("projects")
        .select("architecture_md, api_contracts_md, project_manifest, stack")
        .eq("id", project_id)
        .single()
        .execute()
    )

    # --- Context Prism Layer 1: Load AST graph for smart file loading ---
    ast_graph = load_graph(tenant_id, project_id, settings)

    # Load relevant existing files from storage
    existing_files = _load_project_files(tenant_id, project_id, settings)

    # If we have an AST graph, use it to prune context
    if ast_graph and existing_files:
        # For now, we keep all files but the graph is available for
        # future impacted-file filtering once we know the plan
        pass

    # --- Context Prism Layer 2: Load architectural ledger ---
    ledger_ctx = get_ledger_context(tenant_id, project_id, settings)

    # --- Context Prism Layer 3: Load vector context ---
    vector_ctx = get_vector_context(
        tenant_id, project_id, prompt, settings, limit=5,
    )

    # --- Context Prism Layer 4: Load integration context ---
    integration_ctx = _fetch_integration_context(tenant_id, project_id, settings)

    # --- Fetch user_id from build record for Nexus persona ---
    build_record = db.table("builds").select("user_id").eq("id", build_id).single().execute()
    user_id = build_record.data.get("user_id", "system") or "system"

    initial_state: BuildState = {
        "build_id": build_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "user_id": user_id,
        "prompt": prompt,
        "settings": settings.model_dump(),
        # Context Prism layers
        "architecture_md": project.data.get("architecture_md", ""),
        "api_contracts_md": project.data.get("api_contracts_md", ""),
        "project_manifest": project.data.get("project_manifest", {}),
        "existing_files": existing_files,
        "ast_graph": ast_graph,
        "ledger_context": ledger_ctx,
        "vector_context": vector_ctx,
        "integration_context": integration_ctx,
        # Discriminator (set by planner_node)
        "build_mode": "",
        "genesis_files": [],
        "surgical_files": [],
        # Pipeline outputs
        "plan": None,
        "plan_from_cache": False,
        "scaffold_files": {},
        "patches": [],
        "review_result": None,
        "review_iterations": 0,
        # HITL checkpoint (architecture plan)
        "hitl_approved": False,
        "hitl_modified_plan": None,
        # Multi-modal pipeline stages
        "requirements": None,
        "requirements_approved": False,
        "figma_key": None,
        "design_contract": None,
        "design_approved": False,
        "frontend_files": {},
        "frontend_approved": False,
        "backend_spec": None,
        "build_phase": "requirements",
        # Sentinel
        "sentinel_result": None,
        # Deployment
        "commit_sha": None,
        "image_tag": None,
        "deploy_url": None,
        # Tracking
        "event_seq": 0,
        "total_tokens_in": 0,
        "total_tokens_out": 0,
        "total_cost_usd": 0.0,
        "model_usage": {},
        "error": None,
    }

    graph = build_graph()
    compiled = graph.compile()
    await compiled.ainvoke(initial_state)


async def run_build_resume(
    build_id: str,
    tenant_id: str,
    project_id: str,
    approved_plan: dict,
    settings: Settings,
):
    """Resume a build after HITL approval."""
    db = _get_db(settings)

    # Load the build data
    build = db.table("builds").select("*").eq("id", build_id).single().execute()

    # Load project data
    project = (
        db.table("projects")
        .select("architecture_md, api_contracts_md, project_manifest, stack")
        .eq("id", project_id)
        .single()
        .execute()
    )

    # Reload context layers
    ast_graph = load_graph(tenant_id, project_id, settings)
    existing_files = _load_project_files(tenant_id, project_id, settings)
    ledger_ctx = get_ledger_context(tenant_id, project_id, settings)
    vector_ctx = get_vector_context(tenant_id, project_id, build.data.get("prompt", ""), settings, limit=5)
    integration_ctx = _fetch_integration_context(tenant_id, project_id, settings)

    # Run discriminator on the approved plan
    disc_result = classify_build(tenant_id, project_id, approved_plan, existing_files, settings)
    if disc_result["overall_mode"] == "genesis":
        approved_plan["needs_scaffold"] = True
    else:
        approved_plan["needs_scaffold"] = False

    resume_state: BuildState = {
        "build_id": build_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "user_id": build.data.get("user_id", "system") or "system",
        "prompt": build.data.get("prompt", ""),
        "settings": settings.model_dump(),
        "architecture_md": project.data.get("architecture_md", ""),
        "api_contracts_md": project.data.get("api_contracts_md", ""),
        "project_manifest": project.data.get("project_manifest", {}),
        "existing_files": existing_files,
        "ast_graph": ast_graph,
        "ledger_context": ledger_ctx,
        "vector_context": vector_ctx,
        "integration_context": integration_ctx,
        "build_mode": disc_result["overall_mode"],
        "genesis_files": disc_result["genesis_files"],
        "surgical_files": disc_result["surgical_files"],
        "plan": approved_plan,
        "plan_from_cache": False,
        "scaffold_files": {},
        "patches": [],
        "review_result": None,
        "review_iterations": 0,
        "hitl_approved": True,  # Key: already approved
        "hitl_modified_plan": None,
        # Multi-modal stages: all pre-code stages already done on initial run
        "requirements": build.data.get("requirements_json"),
        "requirements_approved": True,    # Skip requirements on resume
        "figma_key": build.data.get("figma_key"),
        "design_contract": build.data.get("design_contract_json"),
        "design_approved": True,           # Skip design on resume
        "frontend_files": {},
        "frontend_approved": False,
        "backend_spec": None,
        "build_phase": "frontend" if approved_plan.get("needs_scaffold") else "integration",
        # Sentinel
        "sentinel_result": None,
        "commit_sha": None,
        "image_tag": None,
        "deploy_url": None,
        "event_seq": build.data.get("event_seq", 0) or 0,
        "total_tokens_in": build.data.get("total_tokens_in", 0) or 0,
        "total_tokens_out": build.data.get("total_tokens_out", 0) or 0,
        "total_cost_usd": float(build.data.get("total_cost_usd", 0) or 0),
        "model_usage": build.data.get("model_usage", {}) or {},
        "error": None,
    }

    graph = build_graph()
    compiled = graph.compile()
    await compiled.ainvoke(resume_state)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_context(state: BuildState) -> str:
    """Build context using all 3 Context Prism layers + Neural Nexus."""
    parts = []

    # --- CRITICAL: Neural Nexus context (UPP + PSM + BLL + Dims 4,5) ---
    try:
        _settings = Settings(**state["settings"])
        from ..nexus.engine import NexusEngine
        nexus = NexusEngine(_settings)
        nexus_ctx = nexus.get_context(
            state["tenant_id"],
            state["project_id"],
            state.get("user_id", "system"),
            "principal_builder",
            query=state.get("prompt", ""),
        )
        nexus_section = nexus_ctx.to_prompt_section()
        if nexus_section:
            parts.append(nexus_section)
    except Exception as nexus_err:
        logger.warning("Nexus context load failed: %s", nexus_err)

    # Layer 2: WARM — Architectural Ledger (read first, per spec)
    ledger = state.get("ledger_context", "")
    if ledger:
        parts.append(ledger)

    # Core project docs
    if state["architecture_md"]:
        parts.append(f"### Architecture\n{state['architecture_md']}")
    if state["api_contracts_md"]:
        parts.append(f"### API Contracts\n{state['api_contracts_md']}")
    if state["project_manifest"]:
        parts.append(f"### Manifest\n```json\n{json.dumps(state['project_manifest'], indent=2)}\n```")

    # Layer 3: COLD — Vector search results
    vector_ctx = state.get("vector_context", "")
    if vector_ctx:
        parts.append(vector_ctx)

    # Layer 4: Integration context — what APIs/SDKs the user has configured
    integration_ctx = state.get("integration_context", "")
    if integration_ctx:
        parts.append(integration_ctx)

    # Layer 1: HOT — AST graph summary (for context pruning awareness)
    graph = state.get("ast_graph")
    if graph:
        node_count = len(graph.get("nodes", []))
        edge_count = len(graph.get("edges", []))
        parts.append(
            f"### Dependency Graph\n"
            f"Project has {node_count} files with {edge_count} "
            f"import edges. Only impacted files are loaded."
        )

    # Discriminator mode info
    mode = state.get("build_mode", "")
    if mode:
        parts.append(f"### Build Mode: {mode.upper()}")
        genesis = state.get("genesis_files", [])
        surgical = state.get("surgical_files", [])
        if genesis:
            parts.append(f"New files (genesis): {', '.join(genesis)}")
        if surgical:
            parts.append(f"Edit files (surgical): {', '.join(surgical)}")

    return "\n\n".join(parts) if parts else "(No existing context — new project)"


def _format_files(files: dict[str, str]) -> str:
    if not files:
        return "(none)"
    parts = []
    for path, content in files.items():
        parts.append(f"### {path}\n```\n{content}\n```")
    return "\n\n".join(parts)


def _parse_json_response(content: str) -> dict:
    """Extract JSON from LLM response, handling markdown code blocks."""
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        lines = lines[1:]  # remove opening fence
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        # Try to find JSON object in the response
        start = content.find("{")
        end = content.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(content[start:end])
            except json.JSONDecodeError:
                pass
    return {"error": "Failed to parse LLM response", "raw": content[:500]}


def _extract_file_from_error(error_msg: str) -> str | None:
    """Extract file path from ESLint or TypeScript error message."""
    import re
    # ESLint format: "path:line:col: message"
    match = re.search(r'([^\s:]+\.\w+):\d+:\d+', error_msg)
    if match:
        return match.group(1)
    # TypeScript format: "path(line,col): error TS..."
    match = re.search(r'([^\s(]+\.\w+)\(\d+,\d+\)', error_msg)
    if match:
        return match.group(1)
    return None


def _extract_files_from_patch(patch: str) -> list[str]:
    """Extract file paths from a unified diff."""
    files = []
    for line in patch.split("\n"):
        if line.startswith("+++ b/"):
            files.append(line[6:])
        elif line.startswith("--- a/"):
            files.append(line[6:])
    return files


def _update_model_usage(current: dict, model: str, response: dict) -> dict:
    usage = dict(current)
    if model not in usage:
        usage[model] = {"tokens_in": 0, "tokens_out": 0, "cost": 0.0, "calls": 0}
    usage[model]["tokens_in"] += response["tokens_in"]
    usage[model]["tokens_out"] += response["tokens_out"]
    usage[model]["cost"] += response["cost"]
    usage[model]["calls"] += 1
    return usage


def _fetch_integration_context(tenant_id: str, project_id: str, settings: Settings) -> str:
    """
    Build the integration context string that the agents receive in their prompts.

    Queries active project integrations and returns a prompt-ready description of
    which APIs/SDKs are configured so that the agents can generate code that
    actually uses them (Stripe, OpenAI, Resend, etc.).

    Returns an empty string when no integrations are configured or on error,
    so this is always safe to call.
    """
    try:
        db = _get_db(settings)
        result = (
            db.table("project_integrations")
            .select("provider,category,config,credentials,display_name")
            .eq("project_id", project_id)
            .eq("tenant_id", tenant_id)
            .eq("status", "active")
            .execute()
        )
        if not result.data:
            return ""

        lines = [
            "## Available Integrations",
            "The user has configured these services. Generate code that USES them:\n",
        ]
        for row in result.data:
            provider = row["provider"]
            config = row.get("config") or {}

            if provider == "openai":
                model = config.get("model", "gpt-4o")
                lines.append(
                    f"- **OpenAI** ({model}): API key configured. "
                    "Use `fetch('https://api.openai.com/v1/chat/completions', ...)` "
                    "with key from `window.__integrations?.openai?.api_key`."
                )
            elif provider == "anthropic":
                lines.append(
                    "- **Anthropic Claude**: API key configured. "
                    "Use `fetch('https://api.anthropic.com/v1/messages', ...)` "
                    "with `x-api-key` header from `window.__integrations?.anthropic?.api_key`."
                )
            elif provider == "google_ai":
                lines.append(
                    "- **Google AI (Gemini)**: API key configured. "
                    "Use fetch with key from `window.__integrations?.google_ai?.api_key`."
                )
            elif provider == "stripe":
                lines.append(
                    "- **Stripe Payments**: Keys configured. Load Stripe.js via CDN and init with "
                    "publishable key from `window.__integrations?.stripe?.publishable_key`. "
                    "NEVER expose the secret key in frontend code."
                )
            elif provider == "resend":
                lines.append(
                    "- **Resend Email**: API key configured. Email sending requires a backend proxy — "
                    "generate a `sendEmail()` helper that calls the preview backend."
                )
            elif provider == "supabase":
                lines.append(
                    "- **Supabase (Custom)**: URL and anon key at `window.__integrations?.supabase`. "
                    "Use `supabase.createClient(url, key)` for auth and database."
                )
            elif provider == "clerk":
                lines.append(
                    "- **Clerk Auth**: Publishable key at `window.__integrations?.clerk?.publishable_key`. "
                    "Load Clerk.js from CDN."
                )
            elif provider == "firebase":
                lines.append(
                    "- **Firebase**: Config at `window.__integrations?.firebase`. "
                    "Load Firebase SDK from CDN."
                )
            else:
                display = row.get("display_name") or provider
                lines.append(
                    f"- **{display}**: Configured. "
                    f"Access via `window.__integrations?.{provider}`."
                )

        return "\n".join(lines)
    except Exception as e:
        logger.warning("Failed to fetch integration context for %s/%s: %s", tenant_id, project_id, e)
        return ""


def _load_project_files(tenant_id: str, project_id: str, settings: Settings) -> dict[str, str]:
    """Load project source files from Supabase Storage."""
    import logging
    _logger = logging.getLogger(__name__)

    db = _get_db(settings)
    try:
        files_list = db.storage.from_("project-assets").list(f"{tenant_id}/{project_id}/src")
        result = {}
        for f in files_list[:50]:  # Limit to 50 most relevant files
            try:
                content = db.storage.from_("project-assets").download(
                    f"{tenant_id}/{project_id}/src/{f['name']}"
                )
                if content:
                    result[f"src/{f['name']}"] = content.decode("utf-8", errors="replace")
            except Exception as file_err:
                _logger.warning(
                    "Failed to download file %s for project %s/%s: %s",
                    f.get("name"), tenant_id, project_id, file_err,
                )
        return result
    except Exception as e:
        _logger.warning(
            "Failed to load project files for %s/%s: %s",
            tenant_id, project_id, e,
        )
        return {}
