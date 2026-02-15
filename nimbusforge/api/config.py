"""
NimbusForge API Configuration.
Loaded from environment variables with sensible defaults.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import model_validator
from functools import lru_cache
import logging

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,  # Don't fail if .env is missing
        extra="ignore",
        case_sensitive=False,
    )
    # --- Supabase ---
    supabase_url: str = "http://localhost:54321"
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""  # privileged — never expose to frontend

    # --- LLM Providers ---
    anthropic_api_key: str = ""
    deepseek_api_key: str = ""

    # --- Model IDs ---
    model_opus: str = "claude-opus-4"
    model_sonnet: str = "claude-sonnet-4"
    model_haiku: str = "claude-haiku-4"
    model_deepseek: str = "deepseek-coder"

    # --- Docker / Deploy ---
    container_registry: str = "gcr.io/nimbusforge"
    deploy_provider: str = "cloudrun"  # "cloudrun" | "flyio"
    gcp_project: str = "nimbusforge"
    gcp_region: str = "us-central1"
    fly_org: str = "nimbusforge"

    # --- Preview ---
    preview_domain: str = "preview.nimbusforge.dev"
    preview_stale_hours: int = 72
    preview_delete_days: int = 7

    # --- Rate Limiting ---
    rate_limit_free: int = 10       # builds per minute
    rate_limit_pro: int = 100
    rate_limit_enterprise: int = 500

    # --- Netlify (One-Click Publish) ---
    netlify_token: str = ""              # Personal access token
    netlify_team_slug: str = "devos"     # Team slug on Netlify
    netlify_site_prefix: str = "devos"   # Prefix for site names (devos-{slug})
    netlify_custom_domain: str = ""      # Base domain for user apps (e.g., "vedaa.io")

    # --- Plan Cache ---
    plan_cache_ttl_seconds: int = 3600  # 1 hour

    # --- Build ---
    build_timeout_seconds: int = 600  # 10 minutes
    max_agent_iterations: int = 5

    @model_validator(mode='after')
    def validate_supabase_credentials(self):
        """Validate that essential Supabase credentials are configured."""
        if not self.supabase_url:
            logger.warning("SUPABASE_URL not set. Preview apps may not persist data.")

        if not self.supabase_anon_key:
            logger.warning("SUPABASE_ANON_KEY not set. Preview apps cannot connect to database.")

        if not self.supabase_service_role_key:
            logger.error("SUPABASE_SERVICE_ROLE_KEY not set. Backend operations will fail.")

        # Log successful configuration
        if self.supabase_url and self.supabase_anon_key and self.supabase_service_role_key:
            logger.info(f"Supabase configured: {self.supabase_url}")

        return self


@lru_cache()
def get_settings() -> Settings:
    return Settings()
