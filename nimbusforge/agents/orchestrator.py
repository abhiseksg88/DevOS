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

    # HITL checkpoint
    hitl_approved: bool             # Whether the HITL gate has been approved
    hitl_modified_plan: dict | None # Modified plan from user, if any

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
# Node: PLANNER (Opus — architecture + task breakdown)
# ---------------------------------------------------------------------------

def planner_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "planning", settings, started_at=datetime.now(timezone.utc).isoformat())
    state["event_seq"] = _emit_event(state, "agent_start", "opus", {"agent": "planner", "message": "Planning architecture and tasks..."}, settings)

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
        state["event_seq"] = _emit_event(state, "info", "opus", {"message": "Using cached plan"}, settings)

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
    state["event_seq"] = _emit_event(state, "agent_start", "deepseek", {"agent": "scaffolder", "message": "Generating project scaffold..."}, settings)

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

    response = call_llm(ModelTier.DEEPSEEK, messages, settings)
    files = _parse_json_response(response["content"]).get("files", {})

    # --- Enforce 120 LOC limit ---
    violations = []
    for path, content in files.items():
        loc = len(content.strip().split("\n"))
        if loc > 120:
            violations.append(f"{path}: {loc} LOC (max 120)")

    if violations:
        state["event_seq"] = _emit_event(
            state, "warning", "deepseek",
            {"message": "LOC violations in scaffold", "violations": violations},
            settings,
        )

    _log_usage(state, "deepseek", response["tokens_in"], response["tokens_out"], response["cost"], settings)
    state["event_seq"] = _emit_event(state, "agent_end", "deepseek", {"agent": "scaffolder", "files_created": list(files.keys())}, settings)

    return {
        "scaffold_files": files,
        "event_seq": state["event_seq"],
        "total_tokens_in": state["total_tokens_in"] + response["tokens_in"],
        "total_tokens_out": state["total_tokens_out"] + response["tokens_out"],
        "total_cost_usd": state["total_cost_usd"] + response["cost"],
        "model_usage": _update_model_usage(state["model_usage"], "deepseek", response),
    }


# ---------------------------------------------------------------------------
# Node: CODER (Sonnet — unified diff patches ONLY)
# ---------------------------------------------------------------------------

def coder_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "coding", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "sonnet", {"agent": "coder", "message": "Generating code patches..."}, settings)

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

    response = call_llm(ModelTier.SONNET, messages, settings)
    result = _parse_json_response(response["content"])
    patches = result.get("patches", [])

    # Phase 2A: Detect SEARCH/REPLACE format and convert to unified diffs
    if not patches and "===EDIT:" in response["content"]:
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
    settings = Settings(**state["settings"])
    _update_build_status(state, "awaiting_approval", settings)

    # Save plan to builds table for resume
    db = _get_db(settings)
    db.table("builds").update({
        "plan_json": state["plan"],
        "status": "awaiting_approval",
    }).eq("id", state["build_id"]).execute()

    state["event_seq"] = _emit_event(
        state, "info", None,
        {
            "message": "Plan ready for review",
            "hitl_required": True,
            "plan": state["plan"],
        },
        settings,
    )

    return {
        "hitl_approved": False,
        "event_seq": state["event_seq"],
    }


def hitl_decision(state: BuildState) -> str:
    """After hitl_gate: if approved -> scaffolder/coder; if not -> end (wait)."""
    if state.get("hitl_approved"):
        plan = state.get("plan", {})
        if plan.get("needs_scaffold", False):
            return "scaffolder"
        return "coder"
    return "__end__"


# ---------------------------------------------------------------------------
# Node: REVIEWER (Sonnet — QA, security, tests)
# ---------------------------------------------------------------------------

def reviewer_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "reviewing", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "sonnet", {"agent": "reviewer", "message": "Reviewing patches..."}, settings)

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

    response = call_llm(ModelTier.SONNET, messages, settings)
    review = _parse_json_response(response["content"])

    _log_usage(state, "sonnet", response["tokens_in"], response["tokens_out"], response["cost"], settings)

    for finding in review.get("findings", []):
        state["event_seq"] = _emit_event(state, "warning" if finding.get("severity") != "critical" else "error", "sonnet", finding, settings)

    state["event_seq"] = _emit_event(
        state, "agent_end", "sonnet",
        {"agent": "reviewer", "approved": review.get("approved", False), "finding_count": len(review.get("findings", []))},
        settings,
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

    from ..pipeline.builder import apply_and_build

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

            nexus.record_feedback(
                tenant_id=state["tenant_id"],
                project_id=state["project_id"],
                user_id=state.get("user_id", "system"),
                event_type="tech_debt_tagged",
                feedback={
                    "clean": sentinel_result.get("clean", False),
                    "errors_fixed": sentinel_result.get("errors_fixed", 0),
                    "remaining_count": len(sentinel_result.get("remaining_errors", [])),
                },
                agent="red_team_sentinel",
                prompt=state["prompt"],
                response_summary=f"Sentinel: {'clean' if sentinel_result.get('clean') else f'{len(sentinel_result.get(\"remaining_errors\", []))} errors remain'}",
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
    settings = Settings(**state["settings"])
    _update_build_status(state, "deploying", settings)
    state["event_seq"] = _emit_event(state, "deploy_progress", None, {"message": "Deploying to preview..."}, settings)

    from ..pipeline.deployer import deploy_preview

    result = deploy_preview(
        tenant_id=state["tenant_id"],
        project_id=state["project_id"],
        build_id=state["build_id"],
        image_tag=state["image_tag"],
        settings=settings,
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
    """After review: if approved -> commit; if rejected and under max iterations -> coder; else -> commit (best-effort)."""
    settings = Settings(**state["settings"])
    review = state.get("review_result", {})

    if review.get("approved", False):
        return "committer"

    if state["review_iterations"] < settings.max_agent_iterations:
        _emit_event(state, "info", None, {"message": f"Review rejected (iteration {state['review_iterations']}), retrying coder..."}, settings)
        return "coder"

    # Max iterations reached — proceed with best effort
    _emit_event(state, "warning", None, {"message": f"Max review iterations ({settings.max_agent_iterations}) reached. Proceeding with best-effort code."}, settings)
    return "committer"


# ---------------------------------------------------------------------------
# Graph construction
# ---------------------------------------------------------------------------

def build_graph() -> StateGraph:
    """Construct the LangGraph agent pipeline with HITL gate."""
    graph = StateGraph(BuildState)

    # Add nodes
    graph.add_node("planner", planner_node)
    graph.add_node("hitl_gate", hitl_gate_node)
    graph.add_node("scaffolder", scaffolder_node)
    graph.add_node("coder", coder_node)
    graph.add_node("reviewer", reviewer_node)
    graph.add_node("committer", committer_node)
    graph.add_node("deployer", deployer_node)

    # Entry point
    graph.set_entry_point("planner")

    # Planner -> HITL gate
    graph.add_edge("planner", "hitl_gate")

    # HITL gate -> scaffolder/coder/end (waits for approval)
    graph.add_conditional_edges("hitl_gate", hitl_decision, {
        "scaffolder": "scaffolder",
        "coder": "coder",
        "__end__": END,
    })

    graph.add_edge("scaffolder", "coder")
    graph.add_edge("coder", "reviewer")
    graph.add_conditional_edges("reviewer", review_decision, {
        "coder": "coder",
        "committer": "committer",
    })
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
        # HITL checkpoint
        "hitl_approved": False,
        "hitl_modified_plan": None,
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
