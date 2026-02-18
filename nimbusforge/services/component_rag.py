"""
Component RAG — Dimension 4 of Neural Nexus.

Indexes React components from project code and provides
semantic retrieval for the agent pipeline. When a user asks
"build a dashboard", the RAG finds existing Card, Chart, Table
components to reuse instead of regenerating from scratch.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from uuid import uuid4

from ..api.config import Settings
from .vector_memory import _generate_embedding

logger = logging.getLogger(__name__)


def _get_db(settings: Settings):
    from supabase import create_client
    return create_client(settings.supabase_url, settings.supabase_service_role_key)


def index_components(
    tenant_id: str,
    project_id: str,
    files: dict[str, str],
    settings: Settings,
) -> int:
    """Scan project files and index React components into the library."""
    db = _get_db(settings)
    indexed = 0

    for path, content in files.items():
        if not path.endswith((".tsx", ".jsx")):
            continue

        components = _extract_components(path, content)
        for comp in components:
            summary = (
                f"{comp['name']}: {comp.get('description', '')} "
                f"Props: {comp.get('props', [])} Tags: {comp.get('tags', [])}"
            )
            embedding = _generate_embedding(summary, settings)

            record: dict[str, Any] = {
                "id": str(uuid4()),
                "tenant_id": tenant_id,
                "project_id": project_id,
                "component_name": comp["name"],
                "file_path": path,
                "props_schema": {"props": comp.get("props", [])},
                "tags": comp.get("tags", []),
            }
            if embedding:
                record["embedding"] = embedding

            try:
                db.table("component_library").upsert(
                    record,
                    on_conflict="project_id,file_path,component_name",
                ).execute()
                indexed += 1
            except Exception as e:
                logger.warning("Failed to index component %s: %s", comp["name"], e)

    return indexed


def find_similar_components(
    project_id: str,
    query: str,
    settings: Settings,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Find components semantically similar to the query."""
    db = _get_db(settings)
    embedding = _generate_embedding(query, settings)

    if embedding:
        try:
            result = db.rpc("match_components", {
                "query_embedding": embedding,
                "match_project_id": project_id,
                "match_count": limit,
            }).execute()
            if result.data:
                return result.data
        except Exception as e:
            logger.warning("Component vector search failed: %s", e)

    # Fallback: text search
    try:
        result = (
            db.table("component_library")
            .select("component_name, file_path, props_schema, tags")
            .eq("project_id", project_id)
            .ilike("component_name", f"%{query[:50]}%")
            .limit(limit)
            .execute()
        )
        return result.data or []
    except Exception:
        return []


def get_component_context(
    project_id: str,
    query: str,
    settings: Settings,
) -> str:
    """Build a prompt-ready context section for component reuse."""
    components = find_similar_components(project_id, query, settings)
    if not components:
        return ""

    lines = ["## Reusable Components (from your project)"]
    for c in components:
        props = c.get("props_schema", {}).get("props", [])
        tags = c.get("tags", [])
        lines.append(
            f"- **{c['component_name']}** (`{c['file_path']}`) "
            f"Props: {', '.join(props) if props else 'none'} "
            f"Tags: {', '.join(tags) if tags else 'none'}"
        )
    lines.append("\nReuse these components instead of creating new ones where possible.")
    return "\n".join(lines)


def _extract_components(path: str, content: str) -> list[dict]:
    """Extract component definitions from a React file."""
    components = []
    patterns = [
        re.compile(r'export\s+default\s+function\s+(\w+)'),
        re.compile(r'export\s+function\s+(\w+)'),
        re.compile(r'export\s+const\s+(\w+)\s*[=:]'),
    ]

    seen = set()
    for pattern in patterns:
        for match in pattern.finditer(content):
            name = match.group(1)
            if name[0].isupper() and name not in seen:
                seen.add(name)
                props = _extract_props(content, name)
                tags = _infer_tags(content)
                components.append({
                    "name": name,
                    "props": props,
                    "tags": tags,
                    "description": _extract_description(content, match.start()),
                })

    return components


def _extract_props(content: str, component_name: str) -> list[str]:
    """Extract prop names from a component definition."""
    # Interface/type definitions
    pattern = re.compile(
        rf'(?:interface|type)\s+{component_name}Props\s*(?:=\s*)?\{{([^}}]+)\}}',
        re.DOTALL,
    )
    match = pattern.search(content)
    if match:
        props_text = match.group(1)
        return [
            p.strip().split(":")[0].strip().rstrip("?")
            for p in props_text.split("\n")
            if ":" in p and not p.strip().startswith("//")
        ]

    # Destructured props
    pattern = re.compile(rf'{component_name}\s*\(\s*\{{\s*([^}}]+)\}}')
    match = pattern.search(content)
    if match:
        return [
            p.strip().split("=")[0].strip()
            for p in match.group(1).split(",")
            if p.strip()
        ]

    return []


def _infer_tags(content: str) -> list[str]:
    """Infer component tags from content."""
    tags = []
    tag_indicators = {
        "form": ["<form", "onSubmit", "handleSubmit"],
        "table": ["<table", "<thead", "<tbody"],
        "list": [".map(", "items.map"],
        "modal": ["modal", "dialog", "overlay"],
        "chart": ["chart", "graph", "visualization"],
        "card": ["card", "Card"],
        "navigation": ["nav", "Nav", "sidebar", "Sidebar"],
        "auth": ["login", "signup", "auth", "password"],
    }
    lower = content.lower()
    for tag, indicators in tag_indicators.items():
        if any(ind.lower() in lower for ind in indicators):
            tags.append(tag)
    return tags


def _extract_description(content: str, start: int) -> str:
    """Extract JSDoc or comment description above the component."""
    lines_before = content[:start].rstrip().split("\n")
    desc_lines = []
    for line in reversed(lines_before[-5:]):
        stripped = line.strip()
        if stripped.startswith("*") or stripped.startswith("//"):
            text = stripped.lstrip("*/ ").strip()
            if text:
                desc_lines.insert(0, text)
        elif stripped == "/**":
            break
        else:
            break
    return " ".join(desc_lines)[:200]
