"""
Shared pytest fixtures for NimbusForge backend tests.

Provides mocked Supabase client, test settings, and FastAPI test client.
"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import MagicMock, AsyncMock
from uuid import UUID

import pytest

# Set required env vars before any imports that trigger Settings validation
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
os.environ.setdefault("SUPABASE_ANON_KEY", "test-anon-key")
os.environ.setdefault("SUPABASE_URL", "http://localhost:54321")
os.environ.setdefault("ANTHROPIC_API_KEY", "test-anthropic-key")
os.environ.setdefault("DEBUG_MODE", "true")


@pytest.fixture
def test_settings():
    """Return a Settings instance with test defaults."""
    from nimbusforge.api.config import Settings
    return Settings(
        supabase_url="http://localhost:54321",
        supabase_anon_key="test-anon-key",
        supabase_service_role_key="test-service-role-key",
        anthropic_api_key="test-anthropic-key",
        debug_mode=True,
        cors_allowed_origins=["http://localhost:3000"],
    )


class MockSupabaseTable:
    """Mock for Supabase table operations with chainable methods."""

    def __init__(self, data: list[dict] | None = None, count: int | None = None):
        self._data = data or []
        self._count = count

    def select(self, *args, **kwargs):
        return self

    def insert(self, data):
        if isinstance(data, dict):
            self._data = [data]
        return self

    def update(self, data):
        return self

    def upsert(self, data, **kwargs):
        return self

    def delete(self):
        return self

    def eq(self, col, val):
        return self

    def neq(self, col, val):
        return self

    def gt(self, col, val):
        return self

    def gte(self, col, val):
        return self

    def in_(self, col, vals):
        return self

    def order(self, col, **kwargs):
        return self

    def limit(self, n):
        return self

    def single(self):
        return self

    def execute(self):
        result = MagicMock()
        result.data = self._data
        result.count = self._count
        return result


class MockSupabaseClient:
    """Lightweight mock for the Supabase Python client."""

    def __init__(self):
        self._tables: dict[str, list[dict]] = {}
        self.auth = MagicMock()
        self.storage = MagicMock()

    def set_table_data(self, table_name: str, data: list[dict]):
        self._tables[table_name] = data

    def table(self, name: str) -> MockSupabaseTable:
        return MockSupabaseTable(self._tables.get(name, []))

    def rpc(self, fn_name: str, params: dict | None = None):
        return MockSupabaseTable()


@pytest.fixture
def mock_db():
    """Return a mock Supabase client."""
    return MockSupabaseClient()


@pytest.fixture
def mock_auth_user():
    """Return a mock authenticated user."""
    from nimbusforge.api.dependencies import AuthUser

    tenant_id = UUID("11111111-1111-1111-1111-111111111111")
    return AuthUser(
        user_id=UUID("22222222-2222-2222-2222-222222222222"),
        email="test@example.com",
        tenant_ids=[tenant_id],
        raw_token="test-token",
        is_service_role=False,
    )


@pytest.fixture
def mock_service_user():
    """Return a mock service-role user (admin access)."""
    from nimbusforge.api.dependencies import AuthUser

    return AuthUser(
        user_id=UUID("00000000-0000-0000-0000-000000000000"),
        email="service-role@nimbusforge.internal",
        tenant_ids=[],
        raw_token="test-service-role-key",
        is_service_role=True,
    )
