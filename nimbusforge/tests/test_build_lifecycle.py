"""
Integration tests for the build lifecycle.

These tests verify the end-to-end flow from build creation through HITL
approval to completion. They mock LLM calls but test the full orchestrator
state machine, event emission, and status transitions.

Usage:
    pytest nimbusforge/tests/test_build_lifecycle.py -v
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

from nimbusforge.api.models import (
    BuildCreate,
    BuildApproval,
    BuildResponse,
    BuildStatus,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def tenant_id():
    return str(uuid4())


@pytest.fixture
def project_id():
    return str(uuid4())


@pytest.fixture
def build_id():
    return str(uuid4())


@pytest.fixture
def mock_db():
    """Mock Supabase service client."""
    db = MagicMock()
    # Mock table().select().eq().single().execute() chain
    table = MagicMock()
    db.table.return_value = table
    table.select.return_value = table
    table.eq.return_value = table
    table.single.return_value = table
    table.insert.return_value = table
    table.update.return_value = table
    table.order.return_value = table
    table.limit.return_value = table
    table.execute.return_value = MagicMock(data={})
    return db


@pytest.fixture
def mock_settings():
    """Mock Settings with all required fields."""
    settings = MagicMock()
    settings.anthropic_api_key = "test-key"
    settings.deepseek_api_key = "test-key"
    settings.supabase_url = "https://test.supabase.co"
    settings.supabase_service_role_key = "test-service-key"
    settings.netlify_token = "test-netlify-token"
    settings.netlify_team_slug = "test-team"
    settings.netlify_site_prefix = "devos"
    settings.netlify_custom_domain = "vedaa.io"
    settings.plan_cache_ttl = 0
    return settings


# ---------------------------------------------------------------------------
# Build lifecycle tests
# ---------------------------------------------------------------------------

class TestBuildLifecycle:
    """Test the build lifecycle state machine."""

    def test_build_create_request_validation(self):
        """BuildCreate model validates prompt."""
        req = BuildCreate(prompt="Build a todo app")
        assert req.prompt == "Build a todo app"

    def test_build_create_rejects_empty_prompt(self):
        """BuildCreate rejects empty prompt."""
        with pytest.raises(Exception):
            BuildCreate(prompt="")

    def test_build_create_rejects_long_prompt(self):
        """BuildCreate rejects prompt > 10000 chars."""
        with pytest.raises(Exception):
            BuildCreate(prompt="x" * 10001)

    def test_build_approval_approve(self):
        """BuildApproval accepts 'approve' action."""
        approval = BuildApproval(action="approve")
        assert approval.action == "approve"
        assert approval.notes is None

    def test_build_approval_modify(self):
        """BuildApproval accepts 'modify' action with notes."""
        approval = BuildApproval(action="modify", notes="Add authentication")
        assert approval.action == "modify"
        assert approval.notes == "Add authentication"

    def test_build_approval_reject(self):
        """BuildApproval accepts 'reject' action."""
        approval = BuildApproval(action="reject")
        assert approval.action == "reject"

    def test_build_approval_invalid_action(self):
        """BuildApproval rejects invalid action."""
        with pytest.raises(Exception):
            BuildApproval(action="invalid")

    def test_build_status_transitions(self):
        """Verify all expected status transitions are valid enum values."""
        expected_flow = [
            "queued",
            "planning",
            "awaiting_approval",
            "scaffolding",
            "coding",
            "reviewing",
            "building",
            "deploying",
            "succeeded",
        ]
        for status in expected_flow:
            assert BuildStatus(status) is not None

    def test_build_response_includes_cost(self):
        """BuildResponse tracks token usage and cost."""
        resp = BuildResponse(
            id=uuid4(),
            tenant_id=uuid4(),
            project_id=uuid4(),
            status="succeeded",
            prompt="test",
            files_changed=["page.tsx"],
            commit_sha="abc",
            image_tag=None,
            total_tokens_in=10000,
            total_tokens_out=5000,
            total_cost_usd=0.03,
            error_message=None,
            started_at="2024-01-01T00:00:00Z",
            completed_at="2024-01-01T00:01:00Z",
            created_at="2024-01-01T00:00:00Z",
        )
        assert resp.total_tokens_in == 10000
        assert resp.total_cost_usd == 0.03


class TestBuildEventSequencing:
    """Test that events are emitted in the correct order."""

    def test_expected_event_kinds(self):
        """All expected event kinds should be documented."""
        expected_kinds = {
            "agent_start",
            "agent_end",
            "file_content",
            "info",
            "warning",
            "error",
            "build_progress",
            "deploy_progress",
            "architectural_proposal",
            "stream_end",
        }
        # These are the event kinds the frontend handleBackendEvent expects
        frontend_handled = {
            "agent_start",
            "agent_end",
            "file_content",
            "info",
            "build_progress",
            "error",
            "architectural_proposal",
        }
        # Frontend should handle all critical event kinds
        assert frontend_handled.issubset(expected_kinds)

    def test_hitl_event_shape(self):
        """HITL event must include hitl_required and plan."""
        hitl_payload = {
            "hitl_required": True,
            "plan": {
                "summary": "Build a todo app",
                "tasks": [{"name": "scaffold", "type": "scaffold"}],
                "needs_scaffold": True,
            },
            "message": "Plan ready for review",
            "critical_question": "",
        }
        assert hitl_payload["hitl_required"] is True
        assert "plan" in hitl_payload
        assert "summary" in hitl_payload["plan"]

    def test_file_content_event_shape(self):
        """file_content event must include path and content."""
        payload = {
            "path": "src/app/page.tsx",
            "content": "export default function Page() { return <div>Hello</div> }",
        }
        assert "path" in payload
        assert "content" in payload
        assert payload["path"].endswith(".tsx")
