"""
Context Prism — Layer 3: COLD (Vector Search)

Uses Supabase Postgres with pgvector for semantic retrieval of:
- File summaries
- Architectural decisions
- Pattern descriptions
- Error/fix pairs

Embeddings are generated via the Anthropic API (voyage model)
or a lightweight local model, then stored in the file_summaries
table with a vector column.
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from uuid import uuid4

import httpx

logger = logging.getLogger(__name__)


def _get_db(settings):
    from supabase import create_client
    return create_client(
        settings.supabase_url, settings.supabase_service_role_key
    )


# -------------------------------------------------------------------
# Embedding generation
# -------------------------------------------------------------------

def _generate_embedding(
    text: str, settings
) -> list[float] | None:
    """
    Generate an embedding vector for the given text.
    Uses Anthropic's voyage-3-lite model via the embeddings API.
    Falls back to a content hash if API is unavailable.
    """
    if not settings.anthropic_api_key:
        return None

    try:
        resp = httpx.post(
            "https://api.voyageai.com/v1/embeddings",
            headers={
                "Authorization": f"Bearer {settings.anthropic_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": "voyage-3-lite",
                "input": [text[:8000]],  # truncate to model limit
            },
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data["data"][0]["embedding"]
    except Exception as e:
        logger.warning("Embedding generation failed: %s", e)

    return None


# -------------------------------------------------------------------
# Store file summaries with embeddings
# -------------------------------------------------------------------

def store_file_summary(
    tenant_id: str,
    project_id: str,
    file_path: str,
    summary: str,
    settings,
) -> None:
    """
    Store a file summary with its embedding in Supabase.
    Uses upsert keyed on (project_id, file_path).
    """
    db = _get_db(settings)
    embedding = _generate_embedding(summary, settings)

    record = {
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "project_id": project_id,
        "file_path": file_path,
        "summary": summary,
        "content_hash": hashlib.sha256(
            summary.encode()
        ).hexdigest()[:16],
    }

    if embedding:
        record["embedding"] = embedding

    db.table("file_summaries").upsert(
        record,
        on_conflict="project_id,file_path",
    ).execute()

    logger.debug(
        "Stored summary for %s/%s:%s",
        tenant_id, project_id, file_path,
    )


def store_decision_embedding(
    tenant_id: str,
    project_id: str,
    decision_text: str,
    decision_type: str,
    settings,
) -> None:
    """Store an architectural decision with embedding."""
    db = _get_db(settings)
    embedding = _generate_embedding(decision_text, settings)

    record = {
        "id": str(uuid4()),
        "tenant_id": tenant_id,
        "project_id": project_id,
        "file_path": f"__decision__{decision_type}",
        "summary": decision_text,
        "content_hash": hashlib.sha256(
            decision_text.encode()
        ).hexdigest()[:16],
    }

    if embedding:
        record["embedding"] = embedding

    db.table("file_summaries").insert(record).execute()


# -------------------------------------------------------------------
# Semantic search
# -------------------------------------------------------------------

def search_similar(
    tenant_id: str,
    project_id: str,
    query: str,
    settings,
    limit: int = 5,
) -> list[dict[str, Any]]:
    """
    Search for semantically similar file summaries / decisions.

    Uses pgvector's cosine similarity via Supabase RPC.
    Falls back to text-based search if embeddings unavailable.
    """
    db = _get_db(settings)
    query_embedding = _generate_embedding(query, settings)

    if query_embedding:
        # Use pgvector similarity search via RPC
        try:
            result = db.rpc("match_file_summaries", {
                "query_embedding": query_embedding,
                "match_tenant_id": tenant_id,
                "match_project_id": project_id,
                "match_count": limit,
            }).execute()

            if result.data:
                return result.data
        except Exception as e:
            logger.warning(
                "Vector search failed, falling back to text: %s", e
            )

    # Fallback: text-based search using ILIKE
    result = (
        db.table("file_summaries")
        .select("file_path, summary")
        .eq("tenant_id", tenant_id)
        .eq("project_id", project_id)
        .ilike("summary", f"%{query[:100]}%")
        .limit(limit)
        .execute()
    )

    return result.data if result.data else []


# -------------------------------------------------------------------
# Context builder for agents
# -------------------------------------------------------------------

def get_vector_context(
    tenant_id: str,
    project_id: str,
    query: str,
    settings,
    limit: int = 5,
) -> str:
    """
    Build a prompt-ready context section from vector search.
    Called when the orchestrator needs pattern/decision context.
    """
    results = search_similar(
        tenant_id, project_id, query, settings, limit
    )

    if not results:
        return ""

    parts = ["<semantic-context>"]
    for r in results:
        path = r.get("file_path", "unknown")
        summary = r.get("summary", "")
        parts.append(f"### {path}\n{summary}")
    parts.append("</semantic-context>")

    return "\n".join(parts)
