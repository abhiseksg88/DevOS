"""
Neural Nexus Orchestrator — The Agent Hierarchy Controller

Manages the 5 Super-Agents with:
  - File-locking (AST-based context loading — only send relevant files)
  - Paginated builds (chain-of-thought for large features)
  - Search & Replace output (95% token savings on edits)
  - Flywheel feedback (every interaction updates the knowledge graph)

Pipeline:
  Shadow CTO (plan) → Staff Engineer (review) → Principal Builder (code)
                                                       ↕
                                               Red Team Sentinel (audit)
                                                       ↓
                                                DevOps Lead (deploy)
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any
from uuid import uuid4

from ..api.config import Settings
from ..agents.llm_router import call_llm, ModelTier
from .engine import NexusEngine
from .super_agents import AGENT_REGISTRY

logger = logging.getLogger(__name__)


# ============================================================================
# File-Locking — AST-Based Context Loading
# ============================================================================

def select_relevant_files(
    all_files: dict[str, str],
    relevant_paths: list[str],
    ignored_paths: list[str],
) -> dict[str, str]:
    """Filter files to only include relevant ones (file-locking strategy).

    This prevents token waste by not sending the entire codebase to agents.
    """
    if not relevant_paths:
        # No file-locking specified — send all (up to 20)
        return dict(list(all_files.items())[:20])

    result: dict[str, str] = {}
    ignored_set = set(ignored_paths)

    for path in relevant_paths:
        if path in ignored_set:
            continue
        if path in all_files:
            result[path] = all_files[path]
        else:
            # Try glob-like matching
            for file_path, content in all_files.items():
                if file_path.endswith(path) or path in file_path:
                    if file_path not in ignored_set:
                        result[file_path] = content

    return result


# ============================================================================
# Search & Replace Parser
# ============================================================================

def apply_search_replace(
    original_content: str,
    edit_blocks: list[dict[str, str]],
) -> str:
    """Apply SEARCH/REPLACE blocks to existing file content.

    Each block has {"search": "...", "replace": "..."}.
    Returns the modified content.
    """
    content = original_content
    for block in edit_blocks:
        search = block.get("search", "")
        replace = block.get("replace", "")
        if search and search in content:
            content = content.replace(search, replace, 1)
        else:
            logger.warning("Search block not found in file: %s...", search[:80])
    return content


def parse_builder_output(raw_output: str) -> list[dict]:
    """Parse the Principal Builder's output into file operations.

    Supports three formats:
    1. ===FILE: path=== ... ===END_FILE===  (full file, new or rewrite)
    2. ===EDIT: path=== <<<SEARCH ... >>>REPLACE ... ===END_EDIT===  (search & replace)
    3. Legacy format: ```language // path ... ```

    Returns list of:
      {"type": "create", "path": "...", "content": "..."}
      {"type": "edit", "path": "...", "edits": [{"search": "...", "replace": "..."}]}
    """
    operations: list[dict] = []

    # Format 1: Full file blocks
    file_regex = r'===FILE:\s*(.+?)===\n([\s\S]*?)===END_FILE==='
    for match in re.finditer(file_regex, raw_output):
        path = match.group(1).strip()
        content = match.group(2).strip()
        if path and content:
            operations.append({
                "type": "create",
                "path": _sanitize_path(path),
                "content": content,
            })

    # Format 2: Edit blocks with search/replace
    edit_regex = r'===EDIT:\s*(.+?)===\n([\s\S]*?)===END_EDIT==='
    for match in re.finditer(edit_regex, raw_output):
        path = match.group(1).strip()
        edit_body = match.group(2)

        edits = []
        sr_regex = r'<<<SEARCH\n([\s\S]*?)>>>REPLACE\n([\s\S]*?)(?=<<<SEARCH|$)'
        for sr_match in re.finditer(sr_regex, edit_body):
            search = sr_match.group(1).rstrip("\n")
            replace = sr_match.group(2).rstrip("\n")
            edits.append({"search": search, "replace": replace})

        if path and edits:
            operations.append({
                "type": "edit",
                "path": _sanitize_path(path),
                "edits": edits,
            })

    # Format 3: Legacy code block format (fallback)
    if not operations:
        code_regex = r'```(?:\w+)?\s*\n?\s*(?:\/\/\s*|\/\*\s*|#\s*)?(?:file:\s*|File:\s*|path:\s*)?([^\n*]+\.\w+)\s*\n([\s\S]*?)```'
        for match in re.finditer(code_regex, raw_output, re.IGNORECASE):
            path = match.group(1).strip().replace("*/", "").strip()
            content = match.group(2).strip()
            if path and content and ("/" in path or "." in path):
                safe_path = _sanitize_path(path)
                if safe_path:
                    operations.append({
                        "type": "create",
                        "path": safe_path,
                        "content": content,
                    })

    return operations


def _sanitize_path(path: str) -> str | None:
    """Sanitize file path — reject traversal and sensitive files."""
    cleaned = path.strip()
    if cleaned.startswith("/") or ".." in cleaned:
        return None
    cleaned = cleaned.lstrip("./\\")
    if not cleaned:
        return None
    blocked = [".env", ".git", ".ssh", "node_modules", "credentials", ".secret"]
    lower = cleaned.lower()
    if any(lower.startswith(b) or f"/{b}" in lower for b in blocked):
        return None
    return cleaned


# ============================================================================
# Nexus Orchestrator — The Main Pipeline
# ============================================================================

class NexusOrchestrator:
    """Orchestrates the 5 Super-Agents with Neural Nexus context."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self.nexus = NexusEngine(settings)

    async def run(
        self,
        tenant_id: str,
        project_id: str,
        user_id: str,
        prompt: str,
        existing_files: dict[str, str],
        build_id: str | None = None,
    ) -> dict[str, Any]:
        """Run the full agent hierarchy pipeline.

        Returns:
            {
                "operations": [...],  # file operations to apply
                "plan": {...},        # CTO's plan
                "review": {...},      # Sentinel's review
                "total_tokens_in": int,
                "total_tokens_out": int,
                "total_cost_usd": float,
            }
        """
        total_tokens_in = 0
        total_tokens_out = 0
        total_cost_usd = 0.0

        # ----- Step 1: Shadow CTO — Plan the work -----
        nexus_ctx = self.nexus.get_context(tenant_id, project_id, user_id, "shadow_cto")
        cto_exec_id = self.nexus.start_agent_execution(
            tenant_id, project_id, build_id,
            "shadow_cto", "plan", "opus",
            input_summary=prompt[:200],
        )

        cto_messages = [
            {"role": "system", "content": AGENT_REGISTRY["shadow_cto"]["system_prompt"]},
            {"role": "user", "content": (
                f"{nexus_ctx.to_prompt_section()}\n\n"
                f"## Available Files\n{_format_file_list(existing_files)}\n\n"
                f"## User Request\n{prompt}"
            )},
        ]

        cto_response = call_llm(ModelTier.OPUS, cto_messages, self.settings, max_tokens=4096)
        plan = _parse_json(cto_response["content"])

        total_tokens_in += cto_response["tokens_in"]
        total_tokens_out += cto_response["tokens_out"]
        total_cost_usd += cto_response["cost"]

        self.nexus.complete_agent_execution(
            cto_exec_id, "succeeded",
            output_summary=plan.get("execution_plan", {}).get("summary", ""),
            output_artifact=plan,
            tokens_in=cto_response["tokens_in"],
            tokens_out=cto_response["tokens_out"],
            cost_usd=cto_response["cost"],
            latency_ms=cto_response["latency_ms"],
        )

        # Update business logic from CTO's insights
        for bl_update in plan.get("business_logic_updates", []):
            self.nexus.upsert_business_logic(
                tenant_id, project_id,
                bl_update.get("entity_type", "function"),
                bl_update.get("entity_path", ""),
                bl_update.get("entity_name", ""),
                bl_update.get("purpose", ""),
                domain=bl_update.get("domain"),
                source="inferred",
            )

        # ----- Step 2: File Locking — Select relevant files -----
        file_locking = plan.get("file_locking", {})
        locked_files = select_relevant_files(
            existing_files,
            file_locking.get("relevant_files", []),
            file_locking.get("ignored_files", []),
        )

        # ----- Step 3: Staff Engineer — Architecture review -----
        agents_required = plan.get("execution_plan", {}).get("agents_required", [])
        staff_review = None

        if "staff_engineer" in agents_required:
            se_exec_id = self.nexus.start_agent_execution(
                tenant_id, project_id, build_id,
                "staff_engineer", "review_architecture", "sonnet",
            )

            se_messages = [
                {"role": "system", "content": AGENT_REGISTRY["staff_engineer"]["system_prompt"]},
                {"role": "user", "content": (
                    f"{nexus_ctx.to_prompt_section()}\n\n"
                    f"## CTO's Plan\n```json\n{json.dumps(plan, indent=2)}\n```\n\n"
                    f"## Relevant Files\n{_format_files(locked_files)}\n\n"
                    f"Review this plan. Check for anti-patterns, existing utilities to reuse, "
                    f"and architectural concerns."
                )},
            ]

            se_response = call_llm(ModelTier.SONNET, se_messages, self.settings, max_tokens=4096)
            staff_review = _parse_json(se_response["content"])

            total_tokens_in += se_response["tokens_in"]
            total_tokens_out += se_response["tokens_out"]
            total_cost_usd += se_response["cost"]

            self.nexus.complete_agent_execution(
                se_exec_id, "succeeded",
                output_summary=f"{'Approved' if staff_review.get('architecture_review', {}).get('approved') else 'Concerns raised'}",
                output_artifact=staff_review,
                tokens_in=se_response["tokens_in"],
                tokens_out=se_response["tokens_out"],
                cost_usd=se_response["cost"],
                latency_ms=se_response["latency_ms"],
            )

            # Tag tech debt found by Staff Engineer
            for debt in staff_review.get("tech_debt_tags", []):
                self.nexus.tag_tech_debt(
                    project_id,
                    debt.get("file", ""),
                    debt.get("severity", "medium"),
                    debt.get("description", ""),
                    "staff_engineer",
                )

        # ----- Step 4: Principal Builder — Generate code -----
        pagination = plan.get("pagination_strategy", {})
        needs_pagination = pagination.get("needs_pagination", False)
        all_operations: list[dict] = []

        if needs_pagination:
            # Paginated build — execute step by step
            steps = pagination.get("steps", [])
            for step in steps:
                step_ops = await self._run_builder_step(
                    tenant_id, project_id, build_id, user_id,
                    nexus_ctx, plan, staff_review, locked_files,
                    step_description=step.get("description", ""),
                    step_files=step.get("files", []),
                )
                all_operations.extend(step_ops["operations"])
                total_tokens_in += step_ops["tokens_in"]
                total_tokens_out += step_ops["tokens_out"]
                total_cost_usd += step_ops["cost"]

                # Apply step results to locked_files for next step's context
                for op in step_ops["operations"]:
                    if op["type"] == "create":
                        locked_files[op["path"]] = op["content"]
                    elif op["type"] == "edit":
                        if op["path"] in locked_files:
                            locked_files[op["path"]] = apply_search_replace(
                                locked_files[op["path"]], op["edits"]
                            )
        else:
            # Single-shot build
            result = await self._run_builder_step(
                tenant_id, project_id, build_id, user_id,
                nexus_ctx, plan, staff_review, locked_files,
            )
            all_operations = result["operations"]
            total_tokens_in += result["tokens_in"]
            total_tokens_out += result["tokens_out"]
            total_cost_usd += result["cost"]

        # ----- Step 5: Red Team Sentinel — Security audit -----
        sentinel_review = None

        if "red_team_sentinel" in agents_required and all_operations:
            sentinel_exec_id = self.nexus.start_agent_execution(
                tenant_id, project_id, build_id,
                "red_team_sentinel", "security_audit", "haiku",
            )

            # Format the generated code for review
            code_for_review = _format_operations(all_operations)

            sentinel_messages = [
                {"role": "system", "content": AGENT_REGISTRY["red_team_sentinel"]["system_prompt"]},
                {"role": "user", "content": (
                    f"## Code to Review\n{code_for_review}\n\n"
                    f"## Original Plan\n{plan.get('execution_plan', {}).get('summary', '')}\n\n"
                    f"Audit this code for security, quality, and performance issues."
                )},
            ]

            sentinel_response = call_llm(ModelTier.HAIKU, sentinel_messages, self.settings, max_tokens=4096)
            sentinel_review = _parse_json(sentinel_response["content"])

            total_tokens_in += sentinel_response["tokens_in"]
            total_tokens_out += sentinel_response["tokens_out"]
            total_cost_usd += sentinel_response["cost"]

            verdict = sentinel_review.get("verdict", "PASS")
            self.nexus.complete_agent_execution(
                sentinel_exec_id, "succeeded" if verdict != "FAIL" else "rejected",
                output_summary=f"Verdict: {verdict}, Grade: {sentinel_review.get('security_grade', '?')}",
                output_artifact=sentinel_review,
                tokens_in=sentinel_response["tokens_in"],
                tokens_out=sentinel_response["tokens_out"],
                cost_usd=sentinel_response["cost"],
                latency_ms=sentinel_response["latency_ms"],
            )

            # Tag tech debt found by Sentinel
            for debt in sentinel_review.get("tech_debt_found", []):
                self.nexus.tag_tech_debt(
                    project_id,
                    debt.get("file", ""),
                    debt.get("severity", "medium"),
                    debt.get("description", ""),
                    "red_team_sentinel",
                )

        # ----- Step 6: Update PSM with new file graph -----
        final_files = dict(locked_files)
        for op in all_operations:
            if op["type"] == "create":
                final_files[op["path"]] = op["content"]
            elif op["type"] == "edit" and op["path"] in final_files:
                final_files[op["path"]] = apply_search_replace(
                    final_files[op["path"]], op["edits"]
                )

        self.nexus.update_file_graph(tenant_id, project_id, final_files)

        # ----- Record feedback -----
        self.nexus.record_feedback(
            tenant_id, project_id, user_id,
            "code_accepted",
            {"files_changed": [op["path"] for op in all_operations]},
            agent="principal_builder",
            prompt=prompt,
            response_summary=f"Generated {len(all_operations)} file operations",
        )

        return {
            "operations": all_operations,
            "plan": plan,
            "staff_review": staff_review,
            "sentinel_review": sentinel_review,
            "total_tokens_in": total_tokens_in,
            "total_tokens_out": total_tokens_out,
            "total_cost_usd": total_cost_usd,
        }

    async def _run_builder_step(
        self,
        tenant_id: str,
        project_id: str,
        build_id: str | None,
        user_id: str,
        nexus_ctx,
        plan: dict,
        staff_review: dict | None,
        locked_files: dict[str, str],
        step_description: str = "",
        step_files: list[str] | None = None,
    ) -> dict:
        """Run a single builder step (used for both single-shot and paginated builds)."""

        builder_exec_id = self.nexus.start_agent_execution(
            tenant_id, project_id, build_id,
            "principal_builder", "generate_code", "sonnet",
            input_summary=step_description or plan.get("execution_plan", {}).get("summary", ""),
        )

        # Build the builder's context
        context_parts = [nexus_ctx.to_prompt_section()]

        # Add Staff Engineer constraints if available
        if staff_review:
            constraints = staff_review.get("constraints", [])
            if constraints:
                context_parts.append("## Staff Engineer Constraints\n" + "\n".join(f"- {c}" for c in constraints))
            reuse = staff_review.get("architecture_review", {}).get("existing_patterns_to_reuse", [])
            if reuse:
                context_parts.append("## Existing Patterns to Reuse\n" + "\n".join(f"- {r}" for r in reuse))

        # Add relevant files (file-locked subset)
        if step_files:
            # Paginated step — only send this step's files
            step_context = {p: c for p, c in locked_files.items() if any(sf in p for sf in step_files)}
            if not step_context:
                step_context = locked_files
        else:
            step_context = locked_files

        context_parts.append(f"## Current Files\n{_format_files(step_context)}")

        # Add plan tasks
        tasks = plan.get("tasks", [])
        if step_description:
            context_parts.append(f"## Current Step\n{step_description}")
        else:
            context_parts.append(f"## Tasks\n```json\n{json.dumps(tasks, indent=2)}\n```")

        builder_prompt = "\n\n".join(context_parts)

        # Select model based on task complexity
        model_tier = ModelTier.SONNET
        for task in tasks:
            if task.get("model_recommendation") == "haiku":
                model_tier = ModelTier.HAIKU
                break

        builder_messages = [
            {"role": "system", "content": AGENT_REGISTRY["principal_builder"]["system_prompt"]},
            {"role": "user", "content": builder_prompt},
        ]

        builder_response = call_llm(model_tier, builder_messages, self.settings, max_tokens=16384)
        operations = parse_builder_output(builder_response["content"])

        self.nexus.complete_agent_execution(
            builder_exec_id, "succeeded",
            output_summary=f"Generated {len(operations)} file operations",
            tokens_in=builder_response["tokens_in"],
            tokens_out=builder_response["tokens_out"],
            cost_usd=builder_response["cost"],
            latency_ms=builder_response["latency_ms"],
        )

        return {
            "operations": operations,
            "tokens_in": builder_response["tokens_in"],
            "tokens_out": builder_response["tokens_out"],
            "cost": builder_response["cost"],
        }


# ============================================================================
# Helpers
# ============================================================================

def _format_file_list(files: dict[str, str]) -> str:
    """Format file paths as a simple list (for CTO's overview)."""
    if not files:
        return "(empty project)"
    lines = []
    for path, content in files.items():
        line_count = content.count("\n") + 1
        lines.append(f"  - {path} ({line_count} lines)")
    return "\n".join(lines)


def _format_files(files: dict[str, str]) -> str:
    """Format files with content (for Builder/Engineer context)."""
    if not files:
        return "(none)"
    parts = []
    for path, content in files.items():
        # Truncate very long files to save tokens
        if len(content) > 8000:
            content = content[:4000] + "\n\n... (truncated) ...\n\n" + content[-2000:]
        parts.append(f"### {path}\n```\n{content}\n```")
    return "\n\n".join(parts)


def _format_operations(operations: list[dict]) -> str:
    """Format file operations for review."""
    parts = []
    for op in operations:
        if op["type"] == "create":
            parts.append(f"### NEW FILE: {op['path']}\n```\n{op['content']}\n```")
        elif op["type"] == "edit":
            edits_str = "\n".join(
                f"SEARCH:\n{e['search']}\nREPLACE:\n{e['replace']}"
                for e in op["edits"]
            )
            parts.append(f"### EDIT: {op['path']}\n{edits_str}")
    return "\n\n".join(parts)


def _parse_json(content: str) -> dict:
    """Extract JSON from LLM response."""
    content = content.strip()
    if content.startswith("```"):
        lines = content.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        content = "\n".join(lines)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        start = content.find("{")
        end = content.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                return json.loads(content[start:end])
            except json.JSONDecodeError:
                pass
    return {"error": "Failed to parse response", "raw": content[:500]}
