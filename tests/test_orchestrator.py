"""Tests for agent orchestrator graph construction and helpers."""

import json
import pytest
from nimbusforge.agents.orchestrator import (
    _parse_json_response,
    _extract_files_from_patch,
    _update_model_usage,
    build_graph,
)


class TestParseJsonResponse:
    """Verify JSON extraction from LLM output."""

    def test_plain_json(self):
        result = _parse_json_response('{"approved": true, "findings": []}')
        assert result["approved"] is True

    def test_json_in_code_block(self):
        text = '```json\n{"approved": false, "findings": ["bug"]}\n```'
        result = _parse_json_response(text)
        assert result["approved"] is False

    def test_json_with_surrounding_text(self):
        text = 'Here is the result: {"files": {"a.ts": "code"}} end.'
        result = _parse_json_response(text)
        assert "files" in result

    def test_invalid_json_returns_error(self):
        result = _parse_json_response("not json at all")
        assert "error" in result

    def test_empty_string(self):
        result = _parse_json_response("")
        assert "error" in result


class TestExtractFilesFromPatch:
    """Verify file path extraction from unified diffs."""

    def test_basic_patch(self):
        patch = """--- a/src/app.tsx
+++ b/src/app.tsx
@@ -1,3 +1,4 @@
+import React from 'react';
 export default function App() {"""
        files = _extract_files_from_patch(patch)
        assert "src/app.tsx" in files

    def test_multiple_files(self):
        patch = """--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old
+new"""
        files = _extract_files_from_patch(patch)
        assert "file1.ts" in files
        assert "file2.ts" in files

    def test_empty_patch(self):
        files = _extract_files_from_patch("")
        assert files == []


class TestUpdateModelUsage:
    """Verify model usage tracking accumulation."""

    def test_new_model(self):
        result = _update_model_usage(
            {},
            "sonnet",
            {"tokens_in": 100, "tokens_out": 200, "cost": 0.01},
        )
        assert result["sonnet"]["tokens_in"] == 100
        assert result["sonnet"]["tokens_out"] == 200
        assert result["sonnet"]["calls"] == 1

    def test_accumulate_existing_model(self):
        current = {"sonnet": {"tokens_in": 100, "tokens_out": 200, "cost": 0.01, "calls": 1}}
        result = _update_model_usage(
            current,
            "sonnet",
            {"tokens_in": 50, "tokens_out": 75, "cost": 0.005},
        )
        assert result["sonnet"]["tokens_in"] == 150
        assert result["sonnet"]["tokens_out"] == 275
        assert result["sonnet"]["calls"] == 2


class TestBuildGraph:
    """Verify LangGraph pipeline construction."""

    def test_graph_compiles(self):
        graph = build_graph()
        compiled = graph.compile()
        assert compiled is not None

    def test_graph_has_expected_nodes(self):
        graph = build_graph()
        node_names = set(graph.nodes.keys())
        expected = {"planner", "scaffolder", "coder", "reviewer", "committer", "deployer"}
        assert expected.issubset(node_names)
