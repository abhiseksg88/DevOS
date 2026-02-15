"""Tests for auth and tenant access control."""

import pytest
from uuid import UUID
from fastapi import HTTPException

from nimbusforge.api.dependencies import AuthUser


class TestAuthUser:
    """Verify tenant access control logic."""

    def test_regular_user_can_access_own_tenant(self, mock_auth_user):
        tenant_id = UUID("11111111-1111-1111-1111-111111111111")
        # Should not raise
        mock_auth_user.assert_tenant_access(tenant_id)

    def test_regular_user_cannot_access_other_tenant(self, mock_auth_user):
        other_tenant = UUID("99999999-9999-9999-9999-999999999999")
        with pytest.raises(HTTPException) as exc_info:
            mock_auth_user.assert_tenant_access(other_tenant)
        assert exc_info.value.status_code == 403

    def test_service_role_can_access_any_tenant(self, mock_service_user):
        any_tenant = UUID("99999999-9999-9999-9999-999999999999")
        # Should not raise even for arbitrary tenant IDs
        mock_service_user.assert_tenant_access(any_tenant)

    def test_service_role_flag(self, mock_service_user, mock_auth_user):
        assert mock_service_user.is_service_role is True
        assert mock_auth_user.is_service_role is False


class TestRateLimiter:
    """Verify rate limiter logic."""

    def test_allows_under_limit(self):
        from nimbusforge.api.dependencies import RateLimiter

        limiter = RateLimiter()
        tenant = UUID("11111111-1111-1111-1111-111111111111")
        for _ in range(5):
            assert limiter.check(tenant, limit=10) is True

    def test_blocks_over_limit(self):
        from nimbusforge.api.dependencies import RateLimiter

        limiter = RateLimiter()
        tenant = UUID("11111111-1111-1111-1111-111111111111")
        for _ in range(10):
            limiter.check(tenant, limit=10)
        assert limiter.check(tenant, limit=10) is False

    def test_different_tenants_independent(self):
        from nimbusforge.api.dependencies import RateLimiter

        limiter = RateLimiter()
        t1 = UUID("11111111-1111-1111-1111-111111111111")
        t2 = UUID("22222222-2222-2222-2222-222222222222")
        for _ in range(10):
            limiter.check(t1, limit=10)
        # t1 is at limit, t2 should still be allowed
        assert limiter.check(t1, limit=10) is False
        assert limiter.check(t2, limit=10) is True
