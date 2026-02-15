"""
NimbusForge Agent Orchestrator — LangGraph Multi-Agent Pipeline

Graph:  Planner (Opus) -> Scaffolder (DeepSeek) -> Coder (Sonnet) -> Reviewer (Haiku) -> Deployer
                                                         ^                  |
                                                         +--- reject -------+

Key behaviors:
- Patch-only: Coder outputs unified diffs, never full files
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

# ---------------------------------------------------------------------------
# Supabase helper (uses service-role)
# ---------------------------------------------------------------------------

def _get_db(settings: Settings):
    from supabase import create_client
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def _ensure_app_data_table(db, settings: Settings) -> bool:
    """Ensure the app_data table exists. Logs warning if missing.

    Returns:
        True if table exists
        False if table is missing (should run migrations)
    """
    try:
        # Test if table exists by attempting a simple query
        db.table("app_data").select("id").limit(1).execute()
        return True
    except Exception as e:
        error_msg = str(e).lower()

        # If table doesn't exist, log warning
        import logging
        _tbl_logger = logging.getLogger(__name__)
        if "relation" in error_msg or "does not exist" in error_msg or "not found" in error_msg:
            _tbl_logger.warning("app_data table not found. Run: supabase db push")
            _tbl_logger.warning("Migration: supabase/migrations/004_app_data_table.sql")
            return True
        else:
            _tbl_logger.info("Database check error (non-critical): %s", e)
            return True


# ---------------------------------------------------------------------------
# State schema for the LangGraph graph
# ---------------------------------------------------------------------------

class BuildState(TypedDict):
    # Identifiers
    build_id: str
    tenant_id: str
    project_id: str
    prompt: str
    settings: dict  # serialized Settings

    # Memory context
    architecture_md: str
    api_contracts_md: str
    project_manifest: dict
    existing_files: dict[str, str]  # path -> content (relevant subset)

    # Pipeline outputs
    plan: dict | None
    plan_from_cache: bool
    scaffold_files: dict[str, str]  # path -> content (new files only)
    patches: list[str]              # unified diff strings
    review_result: dict | None      # {"approved": bool, "findings": [...]}
    review_iterations: int

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
        return {"plan": plan, "plan_from_cache": True, "event_seq": state["event_seq"]}

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

    return {
        "plan": plan,
        "plan_from_cache": False,
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
    settings = Settings(**state["settings"])
    _update_build_status(state, "scaffolding", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "deepseek", {"agent": "scaffolder", "message": "Generating project scaffold..."}, settings)

    plan = state["plan"]
    context = _build_context(state)

    messages = [
        {"role": "system", "content": SCAFFOLDER_SYSTEM},
        {"role": "user", "content": f"## Plan\n```json\n{json.dumps(plan, indent=2)}\n```\n\n## Context\n{context}\n\nGenerate the file tree and base content for the new files described in the plan. Output JSON: {{\"files\": {{\"path\": \"content\", ...}}}}"},
    ]

    response = call_llm(ModelTier.DEEPSEEK, messages, settings)
    files = _parse_json_response(response["content"]).get("files", {})

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

    messages = [
        {"role": "system", "content": CODER_SYSTEM},
        {"role": "user", "content": (
            f"## Plan\n```json\n{json.dumps(plan, indent=2)}\n```\n\n"
            f"## Existing Files\n{_format_files(state['existing_files'])}\n\n"
            f"## Scaffold Files\n{_format_files(state.get('scaffold_files', {}))}\n\n"
            f"## Context\n{context}"
            f"{review_feedback}\n\n"
            f"Generate ONLY unified diff patches (git apply compatible). "
            f"Output JSON: {{\"patches\": [\"--- a/file\\n+++ b/file\\n@@ ...\\n...\", ...], \"files_changed\": [\"path\", ...]}}"
        )},
    ]

    response = call_llm(ModelTier.SONNET, messages, settings)
    result = _parse_json_response(response["content"])
    patches = result.get("patches", [])

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
# Node: REVIEWER (Haiku — QA, security, tests)
# ---------------------------------------------------------------------------

def reviewer_node(state: BuildState) -> dict:
    settings = Settings(**state["settings"])
    _update_build_status(state, "reviewing", settings)
    state["event_seq"] = _emit_event(state, "agent_start", "haiku", {"agent": "reviewer", "message": "Reviewing patches..."}, settings)

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

    response = call_llm(ModelTier.HAIKU, messages, settings)
    review = _parse_json_response(response["content"])

    _log_usage(state, "haiku", response["tokens_in"], response["tokens_out"], response["cost"], settings)

    for finding in review.get("findings", []):
        state["event_seq"] = _emit_event(state, "warning" if finding.get("severity") != "critical" else "error", "haiku", finding, settings)

    state["event_seq"] = _emit_event(
        state, "agent_end", "haiku",
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
        "model_usage": _update_model_usage(state["model_usage"], "haiku", response),
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

    state["event_seq"] = _emit_event(
        state, "build_progress", None,
        {"message": "Build complete", "commit_sha": result["commit_sha"], "image_tag": result["image_tag"]},
        settings,
    )

    return {
        "commit_sha": result["commit_sha"],
        "image_tag": result["image_tag"],
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
    """Construct the LangGraph agent pipeline."""
    graph = StateGraph(BuildState)

    # Add nodes
    graph.add_node("planner", planner_node)
    graph.add_node("scaffolder", scaffolder_node)
    graph.add_node("coder", coder_node)
    graph.add_node("reviewer", reviewer_node)
    graph.add_node("committer", committer_node)
    graph.add_node("deployer", deployer_node)

    # Entry point
    graph.set_entry_point("planner")

    # Edges
    graph.add_conditional_edges("planner", should_scaffold, {
        "scaffolder": "scaffolder",
        "coder": "coder",
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

    # Load relevant existing files from storage
    existing_files = _load_project_files(tenant_id, project_id, settings)

    initial_state: BuildState = {
        "build_id": build_id,
        "tenant_id": tenant_id,
        "project_id": project_id,
        "prompt": prompt,
        "settings": settings.model_dump(),
        "architecture_md": project.data.get("architecture_md", ""),
        "api_contracts_md": project.data.get("api_contracts_md", ""),
        "project_manifest": project.data.get("project_manifest", {}),
        "existing_files": existing_files,
        "plan": None,
        "plan_from_cache": False,
        "scaffold_files": {},
        "patches": [],
        "review_result": None,
        "review_iterations": 0,
        "commit_sha": None,
        "image_tag": None,
        "deploy_url": None,
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


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _build_context(state: BuildState) -> str:
    parts = []
    if state["architecture_md"]:
        parts.append(f"### Architecture\n{state['architecture_md']}")
    if state["api_contracts_md"]:
        parts.append(f"### API Contracts\n{state['api_contracts_md']}")
    if state["project_manifest"]:
        parts.append(f"### Manifest\n```json\n{json.dumps(state['project_manifest'], indent=2)}\n```")
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
