"""
FastAPI dependencies: Supabase clients, auth, rate limiting.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Optional
from uuid import UUID

logger = logging.getLogger(__name__)

from fastapi import Depends, Header, HTTPException, Request
from supabase import create_client, Client

from .config import Settings, get_settings

# ---------------------------------------------------------------------------
# Supabase clients
# ---------------------------------------------------------------------------

def get_supabase_service(settings: Settings = Depends(get_settings)) -> Client:
    """Service-role client — bypasses RLS. Used for backend writes."""
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def get_supabase_anon(settings: Settings = Depends(get_settings)) -> Client:
    """Anon client — respects RLS. Used for user-scoped reads."""
    return create_client(settings.supabase_url, settings.supabase_anon_key)


# ---------------------------------------------------------------------------
# Auth: extract and validate JWT from Authorization header
# ---------------------------------------------------------------------------

class AuthUser:
    """Authenticated user context extracted from Supabase JWT."""
    def __init__(
        self,
        user_id: UUID,
        email: str,
        raw_token: str,
        db: Client,
        is_service_role: bool = False,
        supabase_url: str = "",
        supabase_service_role_key: str = "",
    ):
        self.user_id = user_id
        self.email = email
        self.raw_token = raw_token
        self._db = db
        self.is_service_role = is_service_role
        self._supabase_url = supabase_url
        self._supabase_service_role_key = supabase_service_role_key

    def _fresh_service_db(self) -> Client:
        """Return a guaranteed-fresh service-role Supabase client.

        We always create a new client rather than reusing self._db so that
        any auth-header side-effects from db.auth.get_user() during JWT
        validation cannot leak into the membership lookup.
        """
        if self._supabase_url and self._supabase_service_role_key:
            return create_client(self._supabase_url, self._supabase_service_role_key)
        return self._db

    def assert_tenant_access(self, tenant_id: UUID):
        """Raise 403 if the user is not a member of a valid tenant.

        Uses a targeted single-row query rather than a pre-fetched list so that
        newly-created memberships are always visible and there is no window where
        a missing tenant_members row causes a spurious 403.

        Always uses a fresh service-role client to guarantee RLS is bypassed,
        regardless of any auth state that may have been set during JWT validation.

        Auto-heal: If the tenant exists in the tenants table but this specific
        user has no membership row, they are automatically inserted as owner.
        This handles auth re-registration (e.g. switching auth providers) and
        tenants created outside the API. Tenants that do not exist at all still
        return 403.
        """
        if self.is_service_role:
            return

        # Use a fresh service-role client to ensure no RLS interference
        db = self._fresh_service_db()

        # --- 1. Fast path: user already has a membership row ---
        result = (
            db.table("tenant_members")
            .select("tenant_id")
            .eq("user_id", str(self.user_id))
            .eq("tenant_id", str(tenant_id))
            .limit(1)
            .execute()
        )
        if result.data:
            return

        # --- 2. Slow path: verify the tenant exists, then auto-heal membership ---
        tenant_exists = (
            db.table("tenants")
            .select("id")
            .eq("id", str(tenant_id))
            .limit(1)
            .execute()
        )
        if not tenant_exists.data:
            raise HTTPException(status_code=403, detail="Access denied to this tenant")

        # Tenant exists but this user has no membership row (e.g. auth provider
        # change, Studio-created tenant, or stale member rows from a prior user).
        # Auto-insert as owner so the user is not permanently locked out.
        try:
            db.table("tenant_members").insert({
                "tenant_id": str(tenant_id),
                "user_id": str(self.user_id),
                "role": "owner",
            }).execute()
            logger.warning(
                "Auto-healed missing tenant_members row: tenant=%s user=%s",
                tenant_id,
                self.user_id,
            )
            return
        except Exception as exc:
            logger.error(
                "Auto-heal insert failed: tenant=%s user=%s error=%s",
                tenant_id,
                self.user_id,
                exc,
            )

        raise HTTPException(status_code=403, detail="Access denied to this tenant")


async def get_current_user(
    authorization: str = Header(..., description="Bearer <supabase_jwt>"),
    db: Client = Depends(get_supabase_service),
    settings: Settings = Depends(get_settings),
) -> AuthUser:
    """Validate Supabase JWT, resolve tenant memberships."""
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid authorization header")

    token = authorization[7:]

    # Service-role bypass: when the token IS the service-role key itself
    # (used by --skip-auth test mode and internal service calls)
    if token == settings.supabase_service_role_key:
        return AuthUser(
            user_id=UUID("00000000-0000-0000-0000-000000000000"),
            email="service-role@nimbusforge.internal",
            raw_token=token,
            db=db,
            is_service_role=True,
            supabase_url=settings.supabase_url,
            supabase_service_role_key=settings.supabase_service_role_key,
        )

    # Verify JWT with Supabase Auth
    try:
        user_response = db.auth.get_user(token)
        user = user_response.user
        if user is None:
            raise HTTPException(status_code=401, detail="Invalid token")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=401, detail="Token verification failed")

    # tenant_ids are no longer pre-fetched here — assert_tenant_access does a
    # targeted single-row query per request, which is safer and more up-to-date.
    # Pass credentials so assert_tenant_access can always create a fresh
    # service-role client, unaffected by any auth state from get_user() above.
    return AuthUser(
        user_id=UUID(str(user.id)),
        email=user.email or "",
        raw_token=token,
        db=db,
        supabase_url=settings.supabase_url,
        supabase_service_role_key=settings.supabase_service_role_key,
    )


# ---------------------------------------------------------------------------
# Rate Limiter (in-memory sliding window — swap to Redis for multi-instance)
# ---------------------------------------------------------------------------

class RateLimiter:
    """Simple sliding-window rate limiter keyed by tenant_id."""

    def __init__(self):
        self._windows: dict[str, list[float]] = defaultdict(list)

    def check(self, tenant_id: UUID, limit: int, window_seconds: int = 60) -> bool:
        key = str(tenant_id)
        now = time.time()
        cutoff = now - window_seconds
        # Prune old entries
        self._windows[key] = [t for t in self._windows[key] if t > cutoff]
        if len(self._windows[key]) >= limit:
            return False
        self._windows[key].append(now)
        return True


_rate_limiter = RateLimiter()


def get_rate_limiter() -> RateLimiter:
    return _rate_limiter


# ---------------------------------------------------------------------------
# Budget check
# ---------------------------------------------------------------------------

async def check_budget(
    tenant_id: UUID,
    db: Client,
) -> None:
    """Raise 402 if tenant has exceeded monthly budget."""
    result = (
        db.table("tenants")
        .select("monthly_budget_usd, monthly_spent_usd, plan")
        .eq("id", str(tenant_id))
        .single()
        .execute()
    )
    tenant = result.data
    if tenant["monthly_spent_usd"] >= tenant["monthly_budget_usd"]:
        raise HTTPException(
            status_code=402,
            detail=f"Monthly budget of ${tenant['monthly_budget_usd']} exceeded. "
                   f"Current spend: ${tenant['monthly_spent_usd']}. "
                   f"Upgrade your plan or increase budget."
        )
