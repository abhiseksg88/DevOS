"""
Observability Feedback Loop — Dimension 5 of Neural Nexus.

Aggregates build metrics and feeds them back into agent context:
- Build success rate
- Average latency per agent
- Cost per build
- Common error patterns
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from ..api.config import Settings

logger = logging.getLogger(__name__)


def _get_db(settings: Settings):
    from supabase import create_client
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def compute_build_stats(
    tenant_id: str,
    project_id: str,
    settings: Settings,
) -> dict[str, Any]:
    """Compute build statistics for the last 20 builds."""
    db = _get_db(settings)

    try:
        builds = (
            db.table("builds")
            .select("status, total_tokens_in, total_tokens_out, total_cost_usd, started_at, completed_at")
            .eq("project_id", project_id)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )
    except Exception as e:
        logger.warning("Failed to fetch builds for stats: %s", e)
        return {}

    if not builds.data:
        return {}

    total = len(builds.data)
    succeeded = sum(1 for b in builds.data if b["status"] == "succeeded")
    failed = sum(1 for b in builds.data if b["status"] == "failed")

    latencies = []
    for b in builds.data:
        if b.get("started_at") and b.get("completed_at"):
            try:
                start = datetime.fromisoformat(b["started_at"].replace("Z", "+00:00"))
                end = datetime.fromisoformat(b["completed_at"].replace("Z", "+00:00"))
                latencies.append((end - start).total_seconds())
            except (ValueError, TypeError):
                pass

    avg_latency = sum(latencies) / len(latencies) if latencies else 0
    avg_cost = sum(float(b.get("total_cost_usd") or 0) for b in builds.data) / total

    stats = {
        "total_builds": total,
        "success_rate": round(succeeded / total * 100, 1) if total else 0,
        "failure_rate": round(failed / total * 100, 1) if total else 0,
        "avg_latency_seconds": round(avg_latency, 1),
        "avg_cost_usd": round(avg_cost, 4),
        "total_cost_usd": round(sum(float(b.get("total_cost_usd") or 0) for b in builds.data), 4),
    }

    # Store in observability_metrics
    try:
        db.table("observability_metrics").upsert({
            "id": str(uuid4()),
            "tenant_id": tenant_id,
            "project_id": project_id,
            "metric_type": "build_stats",
            "period": "last_20",
            "data": stats,
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }, on_conflict="project_id,metric_type,period").execute()
    except Exception as e:
        logger.warning("Failed to store build stats: %s", e)

    return stats


def compute_error_patterns(
    project_id: str,
    settings: Settings,
) -> list[dict]:
    """Analyze common error patterns from recent sentinel runs."""
    db = _get_db(settings)

    try:
        feedback = (
            db.table("nexus_feedback")
            .select("feedback")
            .eq("project_id", project_id)
            .eq("event_type", "tech_debt_tagged")
            .order("created_at", desc=True)
            .limit(50)
            .execute()
        )
    except Exception:
        return []

    error_counts: dict[str, int] = {}
    for fb in (feedback.data or []):
        remaining = fb.get("feedback", {}).get("remaining_count", 0)
        if remaining > 0:
            for error in fb.get("feedback", {}).get("errors", []):
                category = _categorize_error(error)
                error_counts[category] = error_counts.get(category, 0) + 1

    return [
        {"pattern": k, "count": v}
        for k, v in sorted(error_counts.items(), key=lambda x: -x[1])[:10]
    ]


def get_observability_context(
    project_id: str,
    settings: Settings,
) -> str:
    """Build a prompt-ready observability context for agents."""
    db = _get_db(settings)

    try:
        result = (
            db.table("observability_metrics")
            .select("metric_type, data")
            .eq("project_id", project_id)
            .execute()
        )
    except Exception:
        return ""

    if not result.data:
        return ""

    lines = ["## Build Observability (Dimension 5)"]
    for metric in result.data:
        data = metric.get("data", {})
        if metric["metric_type"] == "build_stats":
            lines.append(
                f"- Last {data.get('total_builds', 0)} builds: "
                f"{data.get('success_rate', 0)}% success rate, "
                f"avg {data.get('avg_latency_seconds', 0)}s, "
                f"avg ${data.get('avg_cost_usd', 0)}/build"
            )

    return "\n".join(lines) if len(lines) > 1 else ""


def _categorize_error(error: str) -> str:
    """Categorize an error message into a pattern."""
    lower = error.lower()
    if "import" in lower or "module" in lower:
        return "missing_imports"
    if "type" in lower:
        return "type_errors"
    if "undefined" in lower:
        return "undefined_references"
    if "unused" in lower:
        return "unused_code"
    return "other"
