"""Tests for Settings validation and hardening (P0-7)."""

import os
import pytest


class TestSettingsValidation:
    """Verify that critical config validation works."""

    def test_missing_service_role_key_raises(self):
        """P0-7: Empty supabase_service_role_key must raise ValueError."""
        from nimbusforge.api.config import Settings

        with pytest.raises(ValueError, match="SUPABASE_SERVICE_ROLE_KEY is required"):
            Settings(
                supabase_url="http://localhost:54321",
                supabase_anon_key="test-key",
                supabase_service_role_key="",
            )

    def test_valid_config_passes(self, test_settings):
        """Valid config should not raise."""
        assert test_settings.supabase_service_role_key == "test-service-role-key"
        assert test_settings.debug_mode is True

    def test_cors_allowed_origins_default(self):
        """Default CORS should include localhost and vedaa.io, not wildcard."""
        from nimbusforge.api.config import Settings

        s = Settings(
            supabase_service_role_key="test-key",
        )
        assert "http://localhost:3000" in s.cors_allowed_origins
        assert "https://vedaa.io" in s.cors_allowed_origins
        assert "*" not in s.cors_allowed_origins

    def test_debug_mode_default_false(self, monkeypatch):
        """Debug mode should default to False."""
        monkeypatch.delenv("DEBUG_MODE", raising=False)
        from nimbusforge.api.config import Settings

        s = Settings(supabase_service_role_key="test-key")
        assert s.debug_mode is False

    def test_missing_anthropic_key_warns_but_passes(self):
        """Missing Anthropic key should not raise (just warns)."""
        from nimbusforge.api.config import Settings

        s = Settings(
            supabase_service_role_key="test-key",
            anthropic_api_key="",
        )
        assert s.anthropic_api_key == ""
