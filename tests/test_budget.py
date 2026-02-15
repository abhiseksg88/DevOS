"""Tests for budget enforcement (cost/budget.py + dependencies.py)."""

import pytest
from unittest.mock import MagicMock
from uuid import UUID

from fastapi import HTTPException
from nimbusforge.api.dependencies import check_budget


class TestBudgetEnforcement:
    """Verify budget check raises 402 when budget is exceeded."""

    @pytest.mark.asyncio
    async def test_budget_exceeded_raises_402(self):
        db = MagicMock()
        tenant_id = UUID("11111111-1111-1111-1111-111111111111")

        # Simulate tenant that has exceeded budget
        mock_result = MagicMock()
        mock_result.data = {
            "monthly_budget_usd": 10.0,
            "monthly_spent_usd": 15.0,
            "plan": "free",
        }
        db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_result

        with pytest.raises(HTTPException) as exc_info:
            await check_budget(tenant_id, db)
        assert exc_info.value.status_code == 402

    @pytest.mark.asyncio
    async def test_budget_under_limit_passes(self):
        db = MagicMock()
        tenant_id = UUID("11111111-1111-1111-1111-111111111111")

        mock_result = MagicMock()
        mock_result.data = {
            "monthly_budget_usd": 100.0,
            "monthly_spent_usd": 5.0,
            "plan": "pro",
        }
        db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_result

        # Should not raise
        await check_budget(tenant_id, db)

    @pytest.mark.asyncio
    async def test_budget_exactly_at_limit_raises(self):
        db = MagicMock()
        tenant_id = UUID("11111111-1111-1111-1111-111111111111")

        mock_result = MagicMock()
        mock_result.data = {
            "monthly_budget_usd": 10.0,
            "monthly_spent_usd": 10.0,
            "plan": "free",
        }
        db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value = mock_result

        with pytest.raises(HTTPException) as exc_info:
            await check_budget(tenant_id, db)
        assert exc_info.value.status_code == 402
