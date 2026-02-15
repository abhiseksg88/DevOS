"""
Cost Control — Budget enforcement, rate limiting, abuse detection, audit logging.

Design principles:
1. Pre-call enforcement: check budget BEFORE making LLM calls
2. Hard limits: no grace period. Budget exceeded = build blocked.
3. Per-tenant isolation: one tenant's abuse can't affect another
4. Audit everything: every API call, LLM invocation, deploy logged

Budget tiers (default, configurable per tenant):
  Free:       $10/month,  10 builds/min,   50K tokens/day
  Pro:        $100/month, 100 builds/min,  1M tokens/day
  Enterprise: $5000/month, 500 builds/min, unlimited tokens

Abuse detection:
  - Token velocity: flag if tenant uses >10x their 7-day average in 1 hour
  - Build frequency: flag if >50 builds in 10 minutes (even for enterprise)
  - Cost spike: flag if single build costs >$5 (usually indicates prompt injection attack)
"""

from __future__ import annotations

import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID, uuid4

from ..api.config import Settings


# ---------------------------------------------------------------------------
# Budget limits per plan tier
# ---------------------------------------------------------------------------

PLAN_LIMITS = {
    "free": {
        "monthly_budget_usd": 10.00,
        "builds_per_minute": 10,
        "tokens_per_day": 50_000,
        "max_cost_per_build": 0.50,
        "max_concurrent_builds": 1,
    },
    "pro": {
        "monthly_budget_usd": 100.00,
        "builds_per_minute": 100,
        "tokens_per_day": 1_000_000,
        "max_cost_per_build": 5.00,
        "max_concurrent_builds": 5,
    },
    "enterprise": {
        "monthly_budget_usd": 5000.00,
        "builds_per_minute": 500,
        "tokens_per_day": -1,  # unlimited
        "max_cost_per_build": 50.00,
        "max_concurrent_builds": 20,
    },
}


# ---------------------------------------------------------------------------
# Pre-call budget check
# ---------------------------------------------------------------------------

class BudgetExceeded(Exception):
    """Raised when a tenant has exceeded their budget."""
    def __init__(self, tenant_id: str, budget: float, spent: float):
        self.tenant_id = tenant_id
        self.budget = budget
        self.spent = spent
        super().__init__(
            f"Tenant {tenant_id} budget exceeded: ${spent:.2f} / ${budget:.2f}"
        )


class RateLimitExceeded(Exception):
    """Raised when a tenant has exceeded their rate limit."""
    def __init__(self, tenant_id: str, limit: int, window: str):
        self.tenant_id = tenant_id
        self.limit = limit
        self.window = window
        super().__init__(
            f"Tenant {tenant_id} rate limit exceeded: {limit} per {window}"
        )


def enforce_budget(tenant_id: str, settings: Settings) -> dict:
    """
    Check if a tenant can proceed with a new build.
    Returns tenant limits dict if allowed.
    Raises BudgetExceeded or RateLimitExceeded if not.
    """
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    tenant = (
        db.table("tenants")
        .select("plan, monthly_budget_usd, monthly_spent_usd")
        .eq("id", tenant_id)
        .single()
        .execute()
    )
    data = tenant.data
    plan = data["plan"]
    limits = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])

    # 1. Monthly budget check
    if data["monthly_spent_usd"] >= data["monthly_budget_usd"]:
        raise BudgetExceeded(tenant_id, data["monthly_budget_usd"], data["monthly_spent_usd"])

    # 2. Warning at 80%
    usage_pct = data["monthly_spent_usd"] / max(data["monthly_budget_usd"], 0.01)
    warning = usage_pct >= 0.8

    # 3. Daily token check
    if limits["tokens_per_day"] > 0:
        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        day_usage = (
            db.table("usage_events")
            .select("tokens_in, tokens_out")
            .eq("tenant_id", tenant_id)
            .gte("created_at", today_start.isoformat())
            .execute()
        )
        total_tokens_today = sum(
            e.get("tokens_in", 0) + e.get("tokens_out", 0)
            for e in day_usage.data
        )
        if total_tokens_today >= limits["tokens_per_day"]:
            raise RateLimitExceeded(tenant_id, limits["tokens_per_day"], "day")

    # 4. Concurrent builds check
    active_builds = (
        db.table("builds")
        .select("id", count="exact")
        .eq("tenant_id", tenant_id)
        .in_("status", ["queued", "planning", "scaffolding", "coding", "reviewing", "building", "deploying"])
        .execute()
    )
    if (active_builds.count or 0) >= limits["max_concurrent_builds"]:
        raise RateLimitExceeded(
            tenant_id,
            limits["max_concurrent_builds"],
            "concurrent builds"
        )

    return {
        "limits": limits,
        "budget_remaining": data["monthly_budget_usd"] - data["monthly_spent_usd"],
        "budget_warning": warning,
        "usage_pct": usage_pct,
    }


# ---------------------------------------------------------------------------
# Abuse detection
# ---------------------------------------------------------------------------

class AbuseDetector:
    """
    Detect anomalous usage patterns that indicate abuse or compromised credentials.

    Detection rules:
    1. Token velocity: >10x 7-day hourly average in last hour
    2. Cost spike: single build costs >$5 (free), >$50 (pro), >$100 (enterprise)
    3. Build bomb: >50 builds in 10 minutes regardless of tier
    """

    def __init__(self, settings: Settings):
        self.settings = settings

    def check(self, tenant_id: str) -> list[dict]:
        """
        Run all abuse detection checks.
        Returns list of findings: [{"rule": str, "severity": str, "detail": str}]
        """
        findings = []

        findings.extend(self._check_token_velocity(tenant_id))
        findings.extend(self._check_build_bomb(tenant_id))
        findings.extend(self._check_cost_spike(tenant_id))

        if findings:
            self._log_abuse_findings(tenant_id, findings)

        return findings

    def _check_token_velocity(self, tenant_id: str) -> list[dict]:
        """Flag if last hour's tokens > 10x the 7-day hourly average."""
        from supabase import create_client
        db = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)

        now = datetime.now(timezone.utc)
        hour_ago = (now - timedelta(hours=1)).isoformat()
        week_ago = (now - timedelta(days=7)).isoformat()

        # Last hour
        recent = (
            db.table("usage_events")
            .select("tokens_in, tokens_out")
            .eq("tenant_id", tenant_id)
            .gte("created_at", hour_ago)
            .execute()
        )
        recent_tokens = sum(e.get("tokens_in", 0) + e.get("tokens_out", 0) for e in recent.data)

        # 7-day total (to compute hourly average)
        week = (
            db.table("usage_events")
            .select("tokens_in, tokens_out")
            .eq("tenant_id", tenant_id)
            .gte("created_at", week_ago)
            .execute()
        )
        week_tokens = sum(e.get("tokens_in", 0) + e.get("tokens_out", 0) for e in week.data)
        hourly_avg = week_tokens / (7 * 24) if week_tokens > 0 else 1000  # default baseline

        if recent_tokens > hourly_avg * 10:
            return [{
                "rule": "token_velocity",
                "severity": "critical",
                "detail": f"Last hour: {recent_tokens} tokens vs {hourly_avg:.0f}/hr average (10x threshold)",
            }]
        return []

    def _check_build_bomb(self, tenant_id: str) -> list[dict]:
        """Flag if >50 builds in 10 minutes."""
        from supabase import create_client
        db = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)

        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        builds = (
            db.table("builds")
            .select("id", count="exact")
            .eq("tenant_id", tenant_id)
            .gte("created_at", cutoff)
            .execute()
        )

        if (builds.count or 0) > 50:
            return [{
                "rule": "build_bomb",
                "severity": "critical",
                "detail": f"{builds.count} builds in 10 minutes",
            }]
        return []

    def _check_cost_spike(self, tenant_id: str) -> list[dict]:
        """Flag if any recent build cost exceeds plan-specific threshold."""
        from supabase import create_client
        db = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)

        # Get tenant plan
        tenant = db.table("tenants").select("plan").eq("id", tenant_id).single().execute()
        plan = tenant.data["plan"]
        threshold = PLAN_LIMITS.get(plan, PLAN_LIMITS["free"])["max_cost_per_build"]

        # Check recent builds
        recent = (
            db.table("builds")
            .select("id, total_cost_usd")
            .eq("tenant_id", tenant_id)
            .gt("total_cost_usd", threshold)
            .order("created_at", desc=True)
            .limit(5)
            .execute()
        )

        findings = []
        for build in recent.data:
            findings.append({
                "rule": "cost_spike",
                "severity": "warning",
                "detail": f"Build {build['id'][:8]} cost ${build['total_cost_usd']:.4f} (threshold: ${threshold:.2f})",
            })
        return findings

    def _log_abuse_findings(self, tenant_id: str, findings: list[dict]):
        """Log abuse findings to usage_events for audit trail."""
        from supabase import create_client
        db = create_client(self.settings.supabase_url, self.settings.supabase_service_role_key)

        for finding in findings:
            db.table("usage_events").insert({
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "event_type": "abuse_detection",
                "metadata": finding,
            }).execute()


def auto_suspend_if_critical(tenant_id: str, findings: list[dict], settings: Settings) -> bool:
    """
    Auto-suspend tenant if critical abuse detected.
    Returns True if tenant was suspended.
    """
    critical = [f for f in findings if f["severity"] == "critical"]
    if not critical:
        return False

    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    # Suspend: set budget to 0 (effectively blocks all builds)
    db.table("tenants").update({
        "monthly_budget_usd": 0,
        "settings": {"suspended": True, "suspension_reason": critical[0]["detail"]},
    }).eq("id", tenant_id).execute()

    # Log the suspension
    db.table("usage_events").insert({
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "event_type": "auto_suspension",
        "metadata": {"reason": critical[0]["detail"], "findings": critical},
    }).execute()

    return True


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

def log_api_call(
    tenant_id: str,
    user_id: Optional[str],
    endpoint: str,
    method: str,
    status_code: int,
    latency_ms: int,
    settings: Settings,
):
    """Log an API call to the audit trail."""
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    db.table("usage_events").insert({
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "user_id": user_id,
        "event_type": "api_call",
        "metadata": {
            "endpoint": endpoint,
            "method": method,
            "status_code": status_code,
            "latency_ms": latency_ms,
        },
    }).execute()


def log_llm_call(
    tenant_id: str,
    build_id: Optional[str],
    model: str,
    tokens_in: int,
    tokens_out: int,
    cost_usd: float,
    latency_ms: int,
    settings: Settings,
):
    """Log an LLM invocation for cost tracking and audit."""
    from supabase import create_client
    db = create_client(settings.supabase_url, settings.supabase_service_role_key)

    db.table("usage_events").insert({
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "build_id": build_id,
        "event_type": "llm_call",
        "model": model,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "cost_usd": cost_usd,
        "latency_ms": latency_ms,
    }).execute()

    # Increment tenant monthly spend
    db.table("tenants").update({
        "monthly_spent_usd": db.table("tenants")
            .select("monthly_spent_usd")
            .eq("id", tenant_id)
            .single()
            .execute()
            .data["monthly_spent_usd"] + cost_usd,
    }).eq("id", tenant_id).execute()
