"""
Phase 2 — Genesis vs Surgical Discriminator

Hard backend discriminator that checks file/route existence.
The LLM does NOT decide the mode — the backend enforces it.

Rules:
  - If ALL target files exist → SURGICAL mode (diff only)
  - If ANY target file is new  → GENESIS mode (scaffold)
  - Mixed case: GENESIS for new files, SURGICAL for existing
"""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any

logger = logging.getLogger(__name__)


class BuildMode(str, Enum):
    GENESIS = "genesis"
    SURGICAL = "surgical"


class FileDisposition:
    """Per-file classification result."""
    def __init__(self, path: str, mode: BuildMode, exists: bool):
        self.path = path
        self.mode = mode
        self.exists = exists


def _get_db(settings):
    from supabase import create_client
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key
    )


def classify_build(
    tenant_id: str,
    project_id: str,
    plan: dict[str, Any],
    existing_files: dict[str, str],
    settings,
) -> dict[str, Any]:
    """
    Classify each file in the plan as GENESIS or SURGICAL.

    Args:
        plan: Planner output with tasks containing
              files_to_modify and files_to_create
        existing_files: Current project files {path: content}

    Returns:
        {
            "overall_mode": "genesis" | "surgical",
            "files": [
                {"path": str, "mode": str, "exists": bool}
            ],
            "genesis_files": [paths],
            "surgical_files": [paths],
        }
    """
    existing_paths = set(existing_files.keys())
    dispositions: list[FileDisposition] = []

    # Collect all file paths from plan tasks
    for task in plan.get("tasks", []):
        for path in task.get("files_to_modify", []):
            exists = path in existing_paths
            mode = BuildMode.SURGICAL if exists else BuildMode.GENESIS
            dispositions.append(
                FileDisposition(path, mode, exists)
            )

        for path in task.get("files_to_create", []):
            # files_to_create are always GENESIS
            dispositions.append(
                FileDisposition(path, BuildMode.GENESIS, False)
            )

    # Deduplicate by path
    seen: set[str] = set()
    unique: list[FileDisposition] = []
    for d in dispositions:
        if d.path not in seen:
            seen.add(d.path)
            unique.append(d)

    genesis_files = [d.path for d in unique if d.mode == BuildMode.GENESIS]
    surgical_files = [d.path for d in unique if d.mode == BuildMode.SURGICAL]

    # Overall mode: if any genesis files, mark as genesis
    if genesis_files:
        overall = BuildMode.GENESIS
    else:
        overall = BuildMode.SURGICAL

    logger.info(
        "Discriminator result for %s/%s: %s "
        "(genesis=%d, surgical=%d)",
        tenant_id, project_id, overall.value,
        len(genesis_files), len(surgical_files),
    )

    return {
        "overall_mode": overall.value,
        "files": [
            {
                "path": d.path,
                "mode": d.mode.value,
                "exists": d.exists,
            }
            for d in unique
        ],
        "genesis_files": genesis_files,
        "surgical_files": surgical_files,
    }


def enforce_mode_constraints(
    mode: BuildMode,
    output: dict[str, Any],
) -> dict[str, Any]:
    """
    Validate that the agent output respects mode constraints.

    SURGICAL mode: must contain only patches, no full files.
    GENESIS mode: may contain scaffold files.

    Returns the output with violations flagged.
    """
    violations: list[str] = []

    if mode == BuildMode.SURGICAL:
        # In surgical mode, there should be no scaffold files
        scaffold = output.get("scaffold_files", {})
        if scaffold:
            violations.append(
                f"SURGICAL mode violation: {len(scaffold)} "
                f"scaffold files found — converting to patches"
            )

        # Patches must exist
        patches = output.get("patches", [])
        if not patches:
            violations.append(
                "SURGICAL mode violation: no patches generated"
            )

    if violations:
        logger.warning(
            "Mode constraint violations: %s",
            "; ".join(violations),
        )
        output["mode_violations"] = violations

    return output
