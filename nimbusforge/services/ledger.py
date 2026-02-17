"""
Context Prism — Layer 2: WARM (Architectural Ledger)

Maintains a project_memory.md file per project that records:
- Architectural decisions
- Pattern choices
- Technology stack decisions
- Known constraints
- Previous errors and fixes

The orchestrator MUST read the ledger before every agent call
and append new decisions after significant changes.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from uuid import uuid4

logger = logging.getLogger(__name__)


def _get_db(settings):
    from supabase import create_client
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key
    )


# -------------------------------------------------------------------
# Ledger CRUD
# -------------------------------------------------------------------

def read_ledger(
    tenant_id: str, project_id: str, settings
) -> str:
    """
    Read the architectural ledger for a project.
    Returns the markdown content, or empty string if none exists.
    """
    db = _get_db(settings)

    # Try project's architecture_md field first
    result = (
        db.table("projects")
        .select("architecture_md")
        .eq("id", project_id)
        .limit(1)
        .execute()
    )
    arch_md = ""
    if result.data:
        arch_md = result.data[0].get("architecture_md") or ""

    # Also load ledger entries from dedicated table
    entries = (
        db.table("app_blueprints")
        .select("decision_type, content, created_at")
        .eq("tenant_id", tenant_id)
        .eq("project_id", project_id)
        .order("created_at", desc=False)
        .limit(50)
        .execute()
    )

    if not entries.data and not arch_md:
        return ""

    parts = []
    if arch_md:
        parts.append(f"# Architecture\n{arch_md}")

    if entries.data:
        parts.append("# Decision Log")
        for entry in entries.data:
            ts = entry.get("created_at", "")[:19]
            dtype = entry.get("decision_type", "note")
            content = entry.get("content", "")
            parts.append(f"## [{ts}] {dtype}\n{content}")

    return "\n\n".join(parts)


def append_decision(
    tenant_id: str,
    project_id: str,
    decision_type: str,
    content: str,
    settings,
) -> None:
    """
    Append a new decision to the architectural ledger.

    decision_type: "architecture" | "pattern" | "constraint"
                   | "error_fix" | "stack" | "note"
    """
    db = _get_db(settings)
    db.table("app_blueprints").insert({
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "project_id": project_id,
        "decision_type": decision_type,
        "content": content,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }).execute()

    logger.info(
        "Ledger entry added for %s/%s: %s",
        tenant_id, project_id, decision_type,
    )


def update_architecture_md(
    project_id: str, new_content: str, settings
) -> None:
    """Update the architecture_md field on the project."""
    db = _get_db(settings)
    db.table("projects").update({
        "architecture_md": new_content,
    }).eq("id", project_id).execute()


# -------------------------------------------------------------------
# Ledger context for agent prompts
# -------------------------------------------------------------------

def get_ledger_context(
    tenant_id: str, project_id: str, settings
) -> str:
    """
    Build a prompt-ready ledger context section.
    Called by the orchestrator before every agent invocation.
    """
    ledger = read_ledger(tenant_id, project_id, settings)
    if not ledger:
        return ""

    return (
        "<architectural-ledger>\n"
        f"{ledger}\n"
        "</architectural-ledger>\n\n"
        "IMPORTANT: Respect all decisions in the architectural "
        "ledger above. Do not contradict established patterns."
    )
