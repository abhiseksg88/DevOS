"""
Context Prism — Layer 1: HOT (AST Graph)

Parses TS/JS/Python files using tree-sitter to build a dependency graph.
Only impacted files are loaded into LLM context based on graph traversal.

Graph structure:
  {
    "nodes": [file_paths],
    "edges": [{"from": path, "to": path, "type": "import"|"export"|"type_ref"}],
    "exports": {path: [exported_symbols]},
    "type_references": {path: [referenced_types]}
  }
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _get_db(settings):
    from supabase import create_client
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key
    )


# -------------------------------------------------------------------
# Import extraction (regex-based, no tree-sitter dependency required)
# -------------------------------------------------------------------

_TS_IMPORT_RE = re.compile(
    r"""(?:import|export)\s+"""
    r"""(?:(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)"""
    r"""\s+from\s+)?['"]([^'"]+)['"]""",
    re.MULTILINE,
)

_PY_IMPORT_RE = re.compile(
    r"""^(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))""",
    re.MULTILINE,
)

_TS_EXPORT_RE = re.compile(
    r"""export\s+(?:default\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)""",
    re.MULTILINE,
)

_TS_TYPE_REF_RE = re.compile(
    r"""\b(?:type|interface)\s+\w+[^{]*\{[^}]*\b(\w+)\b""",
    re.MULTILINE,
)


def _extract_ts_imports(content: str) -> list[str]:
    """Extract import paths from TS/JS source."""
    return _TS_IMPORT_RE.findall(content)


def _extract_py_imports(content: str) -> list[str]:
    """Extract import module names from Python source."""
    results = []
    for match in _PY_IMPORT_RE.finditer(content):
        mod = match.group(1) or match.group(2)
        if mod:
            results.append(mod)
    return results


def _extract_exports(content: str) -> list[str]:
    """Extract exported symbol names from TS/JS source."""
    return _TS_EXPORT_RE.findall(content)


def _resolve_import(
    source_path: str, import_path: str, all_paths: set[str]
) -> str | None:
    """Resolve a relative import to an absolute file path."""
    if not import_path.startswith("."):
        return None  # external package

    source_dir = str(Path(source_path).parent)
    candidates = [
        str(Path(source_dir) / import_path),
        str(Path(source_dir) / import_path) + ".ts",
        str(Path(source_dir) / import_path) + ".tsx",
        str(Path(source_dir) / import_path) + ".js",
        str(Path(source_dir) / import_path) + ".jsx",
        str(Path(source_dir) / import_path / "index.ts"),
        str(Path(source_dir) / import_path / "index.tsx"),
    ]
    # Handle @/ alias
    if import_path.startswith("@/"):
        alias_path = "src/" + import_path[2:]
        candidates.extend([
            alias_path,
            alias_path + ".ts",
            alias_path + ".tsx",
            alias_path + "/index.ts",
            alias_path + "/index.tsx",
        ])

    for candidate in candidates:
        normalized = str(Path(candidate))
        if normalized in all_paths:
            return normalized
    return None


# -------------------------------------------------------------------
# Graph building
# -------------------------------------------------------------------

def build_dependency_graph(
    files: dict[str, str],
) -> dict[str, Any]:
    """
    Build a dependency graph from a dict of {path: content}.

    Returns:
        {
            "nodes": [paths],
            "edges": [{"from": p, "to": p, "type": str}],
            "exports": {path: [symbols]},
            "type_references": {path: [types]}
        }
    """
    all_paths = set(files.keys())
    nodes = sorted(all_paths)
    edges: list[dict[str, str]] = []
    exports: dict[str, list[str]] = {}
    type_refs: dict[str, list[str]] = {}

    for path, content in files.items():
        is_python = path.endswith(".py")

        if is_python:
            raw_imports = _extract_py_imports(content)
        else:
            raw_imports = _extract_ts_imports(content)

        # Resolve imports to file paths
        for imp in raw_imports:
            resolved = _resolve_import(path, imp, all_paths)
            if resolved:
                edges.append({
                    "from": path,
                    "to": resolved,
                    "type": "import",
                })

        # Extract exports (TS/JS only)
        if not is_python:
            syms = _extract_exports(content)
            if syms:
                exports[path] = syms

    return {
        "nodes": nodes,
        "edges": edges,
        "exports": exports,
        "type_references": type_refs,
    }


# -------------------------------------------------------------------
# Graph traversal — find impacted files
# -------------------------------------------------------------------

def get_impacted_files(
    graph: dict[str, Any],
    changed_files: list[str],
    max_depth: int = 3,
) -> list[str]:
    """
    Given a set of changed files, traverse the graph to find all
    files that import from or are imported by the changed set.

    Returns a deduplicated list of impacted file paths.
    """
    # Build adjacency lists (bidirectional)
    forward: dict[str, set[str]] = {}
    reverse: dict[str, set[str]] = {}
    for edge in graph.get("edges", []):
        src, dst = edge["from"], edge["to"]
        forward.setdefault(src, set()).add(dst)
        reverse.setdefault(dst, set()).add(src)

    visited: set[str] = set()
    queue: list[tuple[str, int]] = [
        (f, 0) for f in changed_files if f in set(graph.get("nodes", []))
    ]

    while queue:
        current, depth = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        if depth >= max_depth:
            continue

        # Traverse both directions
        for neighbor in forward.get(current, set()):
            if neighbor not in visited:
                queue.append((neighbor, depth + 1))
        for neighbor in reverse.get(current, set()):
            if neighbor not in visited:
                queue.append((neighbor, depth + 1))

    return sorted(visited)


# -------------------------------------------------------------------
# Persistence — store/load graph in Supabase
# -------------------------------------------------------------------

def persist_graph(
    tenant_id: str,
    project_id: str,
    graph: dict[str, Any],
    settings,
) -> None:
    """Store the build graph in Supabase."""
    db = _get_db(settings)
    from uuid import uuid4

    db.table("build_graphs").upsert({
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "project_id": project_id,
        "graph_json": graph,
        "node_count": len(graph.get("nodes", [])),
        "edge_count": len(graph.get("edges", [])),
    }, on_conflict="tenant_id,project_id").execute()

    logger.info(
        "Persisted build graph for %s/%s: %d nodes, %d edges",
        tenant_id, project_id,
        len(graph.get("nodes", [])),
        len(graph.get("edges", [])),
    )


def load_graph(
    tenant_id: str, project_id: str, settings
) -> dict[str, Any] | None:
    """Load the build graph from Supabase."""
    db = _get_db(settings)
    result = (
        db.table("build_graphs")
        .select("graph_json")
        .eq("tenant_id", tenant_id)
        .eq("project_id", project_id)
        .limit(1)
        .execute()
    )
    if result.data:
        return result.data[0]["graph_json"]
    return None
