"""
Edge DB Provisioning — Per-project Neon database branches.

Foundation layer for Phase 4B. Provides:
- Create a Neon branch per project
- Store connection details in project_integrations
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..api.config import Settings

logger = logging.getLogger(__name__)

NEON_API_BASE = "https://console.neon.tech/api/v2"


async def provision_project_db(
    tenant_id: str,
    project_id: str,
    project_slug: str,
    settings: Settings,
) -> dict[str, Any]:
    """Create a Neon branch for a project. Returns connection details."""
    if not settings.neon_api_key:
        raise ValueError("NEON_API_KEY not configured")

    headers = {
        "Authorization": f"Bearer {settings.neon_api_key}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{NEON_API_BASE}/projects/{settings.neon_project_id}/branches",
            headers=headers,
            json={
                "branch": {
                    "name": f"vedaa-{project_slug}-{project_id[:8]}",
                },
                "endpoints": [{"type": "read_write"}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()

    branch = data.get("branch", {})
    endpoints = data.get("endpoints", [])
    connection_uri = data.get("connection_uris", [{}])[0].get("connection_uri", "")

    return {
        "branch_id": branch.get("id"),
        "branch_name": branch.get("name"),
        "endpoint_id": endpoints[0].get("id") if endpoints else None,
        "connection_uri": connection_uri,
        "host": endpoints[0].get("host") if endpoints else None,
    }
