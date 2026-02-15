"""Tests for LLM router model selection and fallback."""

import pytest
from nimbusforge.agents.llm_router import ModelTier


class TestModelTier:
    """Verify model tier enum is properly defined."""

    def test_model_tiers_exist(self):
        assert ModelTier.OPUS is not None
        assert ModelTier.SONNET is not None
        assert ModelTier.HAIKU is not None
        assert ModelTier.DEEPSEEK is not None

    def test_model_tiers_are_distinct(self):
        tiers = [ModelTier.OPUS, ModelTier.SONNET, ModelTier.HAIKU, ModelTier.DEEPSEEK]
        assert len(set(tiers)) == 4
