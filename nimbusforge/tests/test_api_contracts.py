"""
Contract tests for API response shape validation.

Verifies that Pydantic response models match the shapes returned by DB queries
and emitted by the pipeline. These tests run without a database — they validate
model parsing against representative payloads.
"""

import pytest
from datetime import datetime, timezone
from uuid import uuid4

from nimbusforge.api.models import (
    BuildResponse,
    BuildEventResponse,
    PublishResponse,
    PublishStatusResponse,
    SubdomainCheckResponse,
    ProjectResponse,
    TenantResponse,
    UsageSummary,
)


# ---------------------------------------------------------------------------
# Build response contracts
# ---------------------------------------------------------------------------

class TestBuildResponseContract:
    """Verify BuildResponse model matches what the DB query returns."""

    def test_minimal_build(self):
        row = {
            "id": str(uuid4()),
            "tenant_id": str(uuid4()),
            "project_id": str(uuid4()),
            "status": "queued",
            "prompt": "Build a todo app",
            "files_changed": [],
            "commit_sha": None,
            "image_tag": None,
            "total_tokens_in": 0,
            "total_tokens_out": 0,
            "total_cost_usd": 0.0,
            "error_message": None,
            "started_at": None,
            "completed_at": None,
            "created_at": "2024-01-01T00:00:00Z",
        }
        build = BuildResponse(**row)
        assert build.status.value == "queued"
        assert build.prompt == "Build a todo app"
        assert build.files_changed == []
        assert build.commit_sha is None

    def test_completed_build(self):
        row = {
            "id": str(uuid4()),
            "tenant_id": str(uuid4()),
            "project_id": str(uuid4()),
            "status": "succeeded",
            "prompt": "Build a CRM with auth",
            "files_changed": ["src/app/page.tsx", "src/components/Login.tsx"],
            "commit_sha": "abc123def456",
            "image_tag": "v1.0.0",
            "total_tokens_in": 15000,
            "total_tokens_out": 8000,
            "total_cost_usd": 0.045,
            "error_message": None,
            "started_at": "2024-01-01T00:01:00Z",
            "completed_at": "2024-01-01T00:02:30Z",
            "created_at": "2024-01-01T00:00:00Z",
        }
        build = BuildResponse(**row)
        assert build.status.value == "succeeded"
        assert len(build.files_changed) == 2
        assert build.total_cost_usd == 0.045

    def test_failed_build(self):
        row = {
            "id": str(uuid4()),
            "tenant_id": str(uuid4()),
            "project_id": str(uuid4()),
            "status": "failed",
            "prompt": "Build something",
            "files_changed": [],
            "commit_sha": None,
            "image_tag": None,
            "total_tokens_in": 500,
            "total_tokens_out": 0,
            "total_cost_usd": 0.001,
            "error_message": "Planner returned invalid JSON",
            "started_at": "2024-01-01T00:01:00Z",
            "completed_at": "2024-01-01T00:01:05Z",
            "created_at": "2024-01-01T00:00:00Z",
        }
        build = BuildResponse(**row)
        assert build.status.value == "failed"
        assert build.error_message == "Planner returned invalid JSON"

    def test_all_build_statuses_valid(self):
        """Every BuildStatus enum value should be parseable."""
        statuses = [
            "queued", "planning", "awaiting_approval", "scaffolding",
            "coding", "reviewing", "building", "deploying",
            "succeeded", "failed", "cancelled",
        ]
        for status in statuses:
            row = {
                "id": str(uuid4()),
                "tenant_id": str(uuid4()),
                "project_id": str(uuid4()),
                "status": status,
                "prompt": "test",
                "files_changed": [],
                "commit_sha": None,
                "image_tag": None,
                "total_tokens_in": 0,
                "total_tokens_out": 0,
                "total_cost_usd": 0.0,
                "error_message": None,
                "started_at": None,
                "completed_at": None,
                "created_at": "2024-01-01T00:00:00Z",
            }
            build = BuildResponse(**row)
            assert build.status.value == status


# ---------------------------------------------------------------------------
# Build event response contracts
# ---------------------------------------------------------------------------

class TestBuildEventContract:
    """Verify BuildEventResponse model matches SSE event shapes."""

    def test_agent_start_event(self):
        event = {
            "id": str(uuid4()),
            "build_id": str(uuid4()),
            "kind": "agent_start",
            "agent": "opus",
            "payload": {"agent": "planner", "message": "Planning build..."},
            "seq": 1,
            "created_at": "2024-01-01T00:00:00Z",
        }
        parsed = BuildEventResponse(**event)
        assert parsed.kind == "agent_start"
        assert parsed.agent == "opus"
        assert parsed.payload["agent"] == "planner"

    def test_file_content_event(self):
        event = {
            "id": str(uuid4()),
            "build_id": str(uuid4()),
            "kind": "file_content",
            "agent": "sonnet",
            "payload": {"path": "src/app/page.tsx", "content": "export default function Page() {}"},
            "seq": 5,
            "created_at": "2024-01-01T00:00:00Z",
        }
        parsed = BuildEventResponse(**event)
        assert parsed.kind == "file_content"
        assert "path" in parsed.payload
        assert "content" in parsed.payload

    def test_hitl_info_event(self):
        event = {
            "id": str(uuid4()),
            "build_id": str(uuid4()),
            "kind": "info",
            "agent": "opus",
            "payload": {
                "hitl_required": True,
                "plan": {"summary": "Build a todo app", "tasks": []},
                "message": "Plan ready for review",
            },
            "seq": 3,
            "created_at": "2024-01-01T00:00:00Z",
        }
        parsed = BuildEventResponse(**event)
        assert parsed.kind == "info"
        assert parsed.payload.get("hitl_required") is True

    def test_error_event(self):
        event = {
            "id": str(uuid4()),
            "build_id": str(uuid4()),
            "kind": "error",
            "agent": None,
            "payload": {"message": "Build failed: timeout"},
            "seq": 10,
            "created_at": "2024-01-01T00:00:00Z",
        }
        parsed = BuildEventResponse(**event)
        assert parsed.kind == "error"
        assert parsed.agent is None


# ---------------------------------------------------------------------------
# Publish response contracts
# ---------------------------------------------------------------------------

class TestPublishResponseContract:

    def test_publish_response_ready(self):
        resp = PublishResponse(
            deploy_id="deploy_123",
            url="https://my-app.vedaa.io",
            status="ready",
            netlify_site_id="site_abc",
            custom_domain="my-app.vedaa.io",
        )
        assert resp.status == "ready"
        assert resp.custom_domain == "my-app.vedaa.io"

    def test_publish_response_deploying(self):
        resp = PublishResponse(
            deploy_id="deploy_456",
            url="https://devos-my-app.netlify.app",
            status="deploying",
            netlify_site_id="site_def",
        )
        assert resp.status == "deploying"
        assert resp.custom_domain is None

    def test_publish_status_response(self):
        resp = PublishStatusResponse(state="ready", url="https://my-app.vedaa.io")
        assert resp.state == "ready"

    def test_subdomain_check_available(self):
        resp = SubdomainCheckResponse(
            available=True,
            subdomain="my-app",
            domain="my-app.vedaa.io",
        )
        assert resp.available is True
        assert resp.reason is None

    def test_subdomain_check_taken(self):
        resp = SubdomainCheckResponse(
            available=False,
            subdomain="taken-app",
            domain="taken-app.vedaa.io",
            reason="This subdomain is already in use.",
        )
        assert resp.available is False
        assert resp.reason is not None


# ---------------------------------------------------------------------------
# Project & Tenant response contracts
# ---------------------------------------------------------------------------

class TestProjectTenantContract:

    def test_project_response(self):
        row = {
            "id": str(uuid4()),
            "tenant_id": str(uuid4()),
            "name": "My App",
            "slug": "my-app",
            "description": "A test app",
            "status": "active",
            "stack": {"framework": "nextjs"},
            "created_at": "2024-01-01T00:00:00Z",
            "updated_at": "2024-01-01T00:00:00Z",
        }
        project = ProjectResponse(**row)
        assert project.name == "My App"
        assert project.status.value == "active"

    def test_tenant_response(self):
        row = {
            "id": str(uuid4()),
            "name": "My Org",
            "slug": "my-org",
            "plan": "free",
            "monthly_budget_usd": 50.0,
            "monthly_spent_usd": 12.5,
            "created_at": "2024-01-01T00:00:00Z",
        }
        tenant = TenantResponse(**row)
        assert tenant.name == "My Org"
        assert tenant.plan.value == "free"

    def test_usage_summary(self):
        row = {
            "tenant_id": str(uuid4()),
            "period": "2024-01",
            "total_builds": 15,
            "total_tokens_in": 150000,
            "total_tokens_out": 80000,
            "total_cost_usd": 2.45,
            "by_model": {
                "claude-opus-4-20250514": {"tokens_in": 50000, "tokens_out": 20000, "cost_usd": 1.5},
                "claude-sonnet-4-20250514": {"tokens_in": 100000, "tokens_out": 60000, "cost_usd": 0.95},
            },
        }
        usage = UsageSummary(**row)
        assert usage.total_builds == 15
        assert "claude-opus-4-20250514" in usage.by_model
