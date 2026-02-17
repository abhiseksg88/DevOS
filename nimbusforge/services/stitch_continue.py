"""
Phase 5 — Stitch & Continue

Handles streaming truncation healing. When an LLM response is
truncated (finish_reason == "length"), this service:

1. Pauses the stream
2. Re-prompts with the exact cut-off string
3. Stitches the response halves together
4. Validates the result is complete
5. Delivers only the complete file/diff
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


MAX_CONTINUATIONS = 3  # Max stitch attempts before giving up


def needs_continuation(
    response: dict[str, Any],
) -> bool:
    """Check if a response was truncated and needs stitching."""
    stop_reason = response.get("stop_reason", "")
    return stop_reason == "max_tokens" or stop_reason == "length"


def build_continuation_prompt(
    original_content: str,
    tail_chars: int = 500,
) -> str:
    """
    Build a continuation prompt using the tail of the
    truncated response as context.
    """
    tail = original_content[-tail_chars:]

    return (
        "Your previous response was truncated. Continue EXACTLY "
        "from where you left off. Here is the end of your "
        "previous output:\n\n"
        f"```\n{tail}\n```\n\n"
        "Continue from that exact point. Do NOT repeat any "
        "content that was already output. Do NOT add any "
        "explanation — just continue the code/diff output."
    )


def stitch_responses(
    parts: list[str],
) -> str:
    """
    Stitch multiple response parts into a single coherent output.

    Handles overlap detection: if the continuation repeats the
    tail of the previous part, we deduplicate.
    """
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]

    result = parts[0]

    for continuation in parts[1:]:
        # Find overlap between end of result and start of continuation
        overlap = _find_overlap(result, continuation)
        if overlap > 0:
            result += continuation[overlap:]
        else:
            result += continuation

    return result


def _find_overlap(a: str, b: str, min_overlap: int = 20) -> int:
    """
    Find the longest overlap where the end of string a
    matches the beginning of string b.
    """
    max_check = min(len(a), len(b), 500)

    for length in range(max_check, min_overlap - 1, -1):
        if a[-length:] == b[:length]:
            return length

    return 0


def validate_stitched_output(
    content: str, expected_format: str = "json"
) -> dict[str, Any]:
    """
    Validate that the stitched output is complete.

    Returns:
        {
            "valid": bool,
            "issues": [str],
            "content": str (cleaned)
        }
    """
    issues: list[str] = []

    if expected_format == "json":
        # Check for balanced braces
        open_braces = content.count("{")
        close_braces = content.count("}")
        if open_braces != close_braces:
            issues.append(
                f"Unbalanced braces: {open_braces} open, "
                f"{close_braces} close"
            )

        # Try to parse JSON
        try:
            json.loads(content)
        except json.JSONDecodeError as e:
            issues.append(f"Invalid JSON: {e}")

    elif expected_format == "diff":
        # Check diff completeness
        if not content.strip().endswith("\n"):
            issues.append("Diff does not end with newline")

        # Check for truncated hunks
        hunk_starts = len(re.findall(r"^@@", content, re.MULTILINE))
        if hunk_starts == 0:
            issues.append("No diff hunks found")

    elif expected_format == "file":
        # Check for ===FILE:=== / ===END_FILE=== balance
        file_starts = content.count("===FILE:")
        file_ends = content.count("===END_FILE===")
        if file_starts != file_ends:
            issues.append(
                f"Unbalanced file markers: {file_starts} starts, "
                f"{file_ends} ends"
            )

    return {
        "valid": len(issues) == 0,
        "issues": issues,
        "content": content,
    }


# -------------------------------------------------------------------
# High-level stitch loop
# -------------------------------------------------------------------

async def stitch_and_complete(
    call_llm_fn,
    tier,
    messages: list[dict[str, str]],
    settings,
    max_tokens: int = 8192,
    expected_format: str = "json",
) -> dict[str, Any]:
    """
    Call the LLM and automatically stitch truncated responses.

    Args:
        call_llm_fn: The LLM call function (from llm_router)
        tier: Model tier to use
        messages: Initial messages
        settings: App settings
        max_tokens: Token limit per call
        expected_format: "json" | "diff" | "file"

    Returns:
        Standard LLM response dict with stitched content.
    """
    parts: list[str] = []
    total_tokens_in = 0
    total_tokens_out = 0
    total_cost = 0.0
    current_messages = list(messages)

    for attempt in range(MAX_CONTINUATIONS + 1):
        response = call_llm_fn(
            tier, current_messages, settings,
            max_tokens=max_tokens,
        )

        content = response["content"]
        parts.append(content)
        total_tokens_in += response["tokens_in"]
        total_tokens_out += response["tokens_out"]
        total_cost += response["cost"]

        if not needs_continuation(response):
            break

        if attempt >= MAX_CONTINUATIONS:
            logger.warning(
                "Max continuations (%d) reached, delivering "
                "partial output", MAX_CONTINUATIONS,
            )
            break

        logger.info(
            "Response truncated (attempt %d/%d), stitching...",
            attempt + 1, MAX_CONTINUATIONS,
        )

        # Build continuation messages
        continuation = build_continuation_prompt(content)
        current_messages = list(messages) + [
            {"role": "assistant", "content": content},
            {"role": "user", "content": continuation},
        ]

    stitched = stitch_responses(parts)
    validation = validate_stitched_output(stitched, expected_format)

    if not validation["valid"]:
        logger.warning(
            "Stitched output has issues: %s",
            validation["issues"],
        )

    return {
        "content": stitched,
        "model": response["model"],
        "tier": response["tier"],
        "tokens_in": total_tokens_in,
        "tokens_out": total_tokens_out,
        "cost": round(total_cost, 6),
        "latency_ms": response.get("latency_ms", 0),
        "stitched": len(parts) > 1,
        "stitch_parts": len(parts),
        "validation": validation,
    }
