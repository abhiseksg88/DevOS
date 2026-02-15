"""
NimbusForge API Configuration.
Loaded from environment variables with sensible defaults.
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
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

    # --- Plan Cache ---
    plan_cache_ttl_seconds: int = 3600  # 1 hour

    # --- Build ---
    build_timeout_seconds: int = 600  # 10 minutes
    max_agent_iterations: int = 5

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    return Settings()
