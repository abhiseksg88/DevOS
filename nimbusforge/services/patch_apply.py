"""
Phase 4 — Surgical Diff Protocol

Replaces any search/replace logic with unified diff patches.
In SURGICAL mode, the LLM outputs ONLY unified diff and the
backend applies it via git apply. Never rewrites entire files.
"""

from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def apply_unified_diff(
    repo_dir: Path,
    patch: str,
    patch_index: int = 0,
) -> dict[str, Any]:
    """
    Apply a single unified diff patch to the repo.

    Strategy:
    1. Try direct git apply
    2. Fall back to 3-way merge
    3. Fall back to --reject (partial apply)

    Returns:
        {
            "success": bool,
            "method": "direct" | "3way" | "reject" | "failed",
            "files_changed": [paths],
            "errors": [str] | None,
        }
    """
    patch_file = repo_dir / f".patch-{patch_index}.diff"
    patch_file.write_text(patch)

    try:
        result = _try_direct_apply(repo_dir, patch_file)
        if result["success"]:
            return result

        # Phase 2A: Try fuzzy apply before 3-way merge
        result = _try_fuzzy_apply(repo_dir, patch_file, fuzz=3)
        if result["success"]:
            return result

        result = _try_3way_merge(repo_dir, patch_file)
        if result["success"]:
            return result

        result = _try_reject_apply(repo_dir, patch_file)
        return result

    finally:
        patch_file.unlink(missing_ok=True)


def _try_direct_apply(
    repo_dir: Path, patch_file: Path
) -> dict[str, Any]:
    """Try direct git apply."""
    check = subprocess.run(
        ["git", "apply", "--check", str(patch_file)],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )

    if check.returncode != 0:
        return {
            "success": False,
            "method": "direct",
            "errors": [check.stderr.strip()],
        }

    subprocess.run(
        ["git", "apply", str(patch_file)],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )

    files = _extract_files_from_patch(patch_file.read_text())
    logger.info("Patch applied directly: %s", files)

    return {
        "success": True,
        "method": "direct",
        "files_changed": files,
        "errors": None,
    }


def _try_fuzzy_apply(
    repo_dir: Path, patch_file: Path, fuzz: int = 3
) -> dict[str, Any]:
    """Try git apply with fuzz factor for approximate matching."""
    result = subprocess.run(
        ["git", "apply", f"--fuzz={fuzz}", str(patch_file)],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {
            "success": False,
            "method": f"fuzz-{fuzz}",
            "errors": [result.stderr.strip()],
        }
    files = _extract_files_from_patch(patch_file.read_text())
    logger.info("Patch applied with fuzz=%d: %s", fuzz, files)
    return {
        "success": True,
        "method": f"fuzz-{fuzz}",
        "files_changed": files,
        "errors": None,
    }


def _try_3way_merge(
    repo_dir: Path, patch_file: Path
) -> dict[str, Any]:
    """Try 3-way merge fallback."""
    result = subprocess.run(
        ["git", "apply", "--3way", str(patch_file)],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        return {
            "success": False,
            "method": "3way",
            "errors": [result.stderr.strip()],
        }

    files = _extract_files_from_patch(patch_file.read_text())
    logger.info("Patch applied via 3-way merge: %s", files)

    return {
        "success": True,
        "method": "3way",
        "files_changed": files,
        "errors": None,
    }


def _try_reject_apply(
    repo_dir: Path, patch_file: Path
) -> dict[str, Any]:
    """Last resort: apply with --reject for partial apply."""
    result = subprocess.run(
        ["git", "apply", "--reject", str(patch_file)],
        cwd=repo_dir,
        capture_output=True,
        text=True,
    )

    files = _extract_files_from_patch(patch_file.read_text())
    errors = []
    if result.stderr.strip():
        errors.append(result.stderr.strip())

    if result.returncode != 0:
        logger.warning("Patch partial apply (reject): %s", errors)
        return {
            "success": False,
            "method": "reject",
            "files_changed": files,
            "errors": errors,
        }

    logger.info("Patch applied with --reject: %s", files)
    return {
        "success": True,
        "method": "reject",
        "files_changed": files,
        "errors": errors if errors else None,
    }


def apply_all_patches(
    repo_dir: Path,
    patches: list[str],
) -> dict[str, Any]:
    """
    Apply multiple patches sequentially.

    Returns:
        {
            "total": int,
            "applied": int,
            "failed": int,
            "results": [per-patch results],
            "all_files_changed": [paths],
        }
    """
    results = []
    all_files: set[str] = set()

    for i, patch in enumerate(patches):
        result = apply_unified_diff(repo_dir, patch, i)
        results.append(result)
        if result.get("files_changed"):
            all_files.update(result["files_changed"])

    applied = sum(1 for r in results if r["success"])
    failed = len(results) - applied

    # Stage all changes
    subprocess.run(
        ["git", "add", "-A"],
        cwd=repo_dir, check=True, capture_output=True,
    )

    return {
        "total": len(patches),
        "applied": applied,
        "failed": failed,
        "results": results,
        "all_files_changed": sorted(all_files),
    }


def _extract_files_from_patch(patch: str) -> list[str]:
    """Extract file paths from a unified diff."""
    files: set[str] = set()
    for line in patch.split("\n"):
        if line.startswith("+++ b/"):
            files.add(line[6:])
        elif line.startswith("+++ ") and not line.startswith("+++ /dev/null"):
            files.add(line[4:].lstrip("b/"))
    return sorted(files)
