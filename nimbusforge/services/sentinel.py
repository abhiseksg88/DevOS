"""
Phase 6 — Sentinel Auto-Heal Loop

Background repair process that runs after each file or patch:
1. Run eslint --fix
2. Run tsc --noEmit
3. If error: feed error to Claude for unified diff fix
4. Loop until clean or max 3 attempts

This ensures every committed file passes lint and type checks.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

MAX_HEAL_ATTEMPTS = 3


def run_sentinel(
    repo_dir: Path,
    settings,
    call_llm_fn=None,
) -> dict[str, Any]:
    """
    Run the sentinel auto-heal loop on the given repo.

    Steps per attempt:
    1. eslint --fix (auto-fix what we can)
    2. tsc --noEmit (check types)
    3. If errors remain, ask Claude for a fix patch
    4. Apply the fix patch
    5. Repeat until clean or max attempts

    Returns:
        {
            "clean": bool,
            "attempts": int,
            "errors_fixed": int,
            "remaining_errors": [str],
        }
    """
    total_fixed = 0
    remaining: list[str] = []

    for attempt in range(MAX_HEAL_ATTEMPTS):
        logger.info(
            "Sentinel attempt %d/%d on %s",
            attempt + 1, MAX_HEAL_ATTEMPTS, repo_dir,
        )

        # Step 1: eslint --fix
        lint_result = _run_eslint_fix(repo_dir)

        # Step 2: tsc --noEmit
        type_errors = _run_tsc_check(repo_dir)

        # Step 2b: Enterprise pattern checks on source files
        enterprise_warnings: list[str] = []
        for src_file in repo_dir.rglob("*.tsx"):
            try:
                code_content = src_file.read_text(encoding="utf-8")
                enterprise_warnings.extend(run_enterprise_checks(code_content))
            except Exception:
                pass
        for src_file in repo_dir.rglob("*.jsx"):
            try:
                code_content = src_file.read_text(encoding="utf-8")
                enterprise_warnings.extend(run_enterprise_checks(code_content))
            except Exception:
                pass
        if enterprise_warnings:
            logger.info(
                "Sentinel enterprise checks: %d warnings",
                len(enterprise_warnings),
            )

        # Combine all errors
        all_errors = (
            lint_result.get("unfixed", [])
            + type_errors
            + enterprise_warnings
        )

        if not all_errors:
            logger.info(
                "Sentinel: clean after %d attempts, "
                "%d errors fixed",
                attempt + 1, total_fixed,
            )
            return {
                "clean": True,
                "attempts": attempt + 1,
                "errors_fixed": total_fixed,
                "remaining_errors": [],
            }

        # Step 3: Ask Claude for fix if we have the LLM function
        if call_llm_fn and settings:
            fix_result = _request_llm_fix(
                repo_dir, all_errors, settings, call_llm_fn,
            )
            if fix_result.get("patches"):
                # Step 4: Apply fix patches
                from .patch_apply import apply_all_patches
                apply_result = apply_all_patches(
                    repo_dir, fix_result["patches"]
                )
                total_fixed += apply_result.get("applied", 0)
        else:
            # No LLM available — just report errors
            remaining = all_errors
            break

        remaining = all_errors

    logger.warning(
        "Sentinel: %d errors remain after %d attempts",
        len(remaining), MAX_HEAL_ATTEMPTS,
    )

    # Separate enterprise warnings from hard errors for clarity
    hard_errors = [e for e in remaining if not any(
        e.startswith(pfx)
        for pfx in ("RBAC:", "FILE_UPLOAD:", "UX:", "CHARTS:", "AUTH:")
    )]
    ent_warnings = [e for e in remaining if e not in hard_errors]

    return {
        "clean": False,
        "attempts": MAX_HEAL_ATTEMPTS,
        "errors_fixed": total_fixed,
        "remaining_errors": hard_errors[:20],
        "enterprise_warnings": ent_warnings[:10],
    }


def run_enterprise_checks(code: str) -> list[str]:
    """Check for enterprise pattern violations in generated code."""
    warnings: list[str] = []

    has_auth = "supabase.auth" in code or "signInWithPassword" in code
    has_roles = "role" in code and ("admin" in code or "manager" in code)
    has_upload = (
        "storage.from" in code
        or 'input type="file"' in code
        or "type='file'" in code
    )
    has_delete = ".delete()" in code
    has_charts = (
        "Recharts" in code or "BarChart" in code or "LineChart" in code
    )

    if has_roles:
        if (
            "isAdmin" not in code
            and "role === 'admin'" not in code
            and 'role === "admin"' not in code
            and "role !== " not in code
        ):
            warnings.append(
                "RBAC: App mentions roles but no role-check conditionals found"
            )

    if has_upload:
        if "file.size" not in code and "maxSize" not in code:
            warnings.append(
                "FILE_UPLOAD: No file size validation found"
            )
        if "file.type" not in code and "accept=" not in code:
            warnings.append(
                "FILE_UPLOAD: No file type validation found"
            )

    if has_delete and "confirm(" not in code and "Confirm" not in code:
        warnings.append(
            "UX: DELETE operation without confirmation dialog"
        )

    if has_charts and "ResponsiveContainer" not in code:
        warnings.append(
            "CHARTS: Using Recharts without ResponsiveContainer — "
            "charts won't resize"
        )

    if has_auth and "AuthGuard" not in code and "getSession" not in code:
        warnings.append(
            "AUTH: Auth operations exist but no session check/guard found"
        )

    return warnings


def _run_eslint_fix(repo_dir: Path) -> dict[str, Any]:
    """Run eslint --fix and return unfixed issues."""
    # Check if eslint config exists
    has_eslint = any(
        (repo_dir / f).exists()
        for f in [
            ".eslintrc.json", ".eslintrc.js",
            ".eslintrc.yml", "eslint.config.js",
        ]
    )

    if not has_eslint:
        return {"ran": False, "unfixed": []}

    result = subprocess.run(
        ["npx", "eslint", "--fix", "--format", "json", "."],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )

    unfixed: list[str] = []
    if result.stdout:
        try:
            eslint_data = json.loads(result.stdout)
            for file_report in eslint_data:
                path = file_report.get("filePath", "")
                for msg in file_report.get("messages", []):
                    if msg.get("severity", 0) >= 2:
                        unfixed.append(
                            f"ESLint [{path}:{msg.get('line', 0)}]: "
                            f"{msg.get('message', '')}"
                        )
        except json.JSONDecodeError:
            pass

    return {"ran": True, "unfixed": unfixed}


def _run_tsc_check(repo_dir: Path) -> list[str]:
    """Run tsc --noEmit and return error messages."""
    if not (repo_dir / "tsconfig.json").exists():
        return []

    result = subprocess.run(
        ["npx", "tsc", "--noEmit", "--pretty", "false"],
        cwd=repo_dir,
        capture_output=True,
        text=True,
        timeout=60,
    )

    errors: list[str] = []
    if result.returncode != 0 and result.stdout:
        for line in result.stdout.strip().split("\n"):
            if "error TS" in line:
                errors.append(f"TypeScript: {line.strip()}")

    return errors


def _request_llm_fix(
    repo_dir: Path,
    errors: list[str],
    settings,
    call_llm_fn,
) -> dict[str, Any]:
    """Ask Claude to fix the errors via unified diff."""
    from ..agents.llm_router import ModelTier

    error_text = "\n".join(errors[:15])  # cap at 15 errors

    messages = [
        {
            "role": "system",
            "content": (
                "You are a code repair agent. You introduced "
                "errors in a codebase. Fix them using ONLY "
                "unified diff patches.\n\n"
                "Output JSON: {\"patches\": [\"diff string\", ...]}"
            ),
        },
        {
            "role": "user",
            "content": (
                "Fix the following errors:\n\n"
                f"```\n{error_text}\n```\n\n"
                "Output ONLY unified diff patches in JSON format."
            ),
        },
    ]

    try:
        response = call_llm_fn(
            ModelTier.SONNET, messages, settings,
            max_tokens=4096,
        )
        content = response.get("content", "")

        # Parse JSON from response
        content = content.strip()
        if content.startswith("```"):
            lines = content.split("\n")
            lines = lines[1:]
            if lines and lines[-1].strip() == "```":
                lines = lines[:-1]
            content = "\n".join(lines)

        start = content.find("{")
        end = content.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(content[start:end])
            return data
    except Exception as e:
        logger.warning("Sentinel LLM fix request failed: %s", e)

    return {"patches": []}
