"""
LLM Router — Model selection, fallback, retry, and cost tracking.

Routing table (task-type-based):
  Claude (Opus):    Architecture, planning, complex decisions
  Claude (Sonnet):  Backend code, diffs, repair patches
  Claude (Haiku):   QA/review/tests/security
  DeepSeek:         UI components, styling, layout, scaffolding

Fallback chain:
  Opus fails    -> Sonnet (degraded planning)
  Sonnet fails  -> DeepSeek (degraded coding)
  Haiku fails   -> Sonnet (over-qualified but available)
  DeepSeek fails -> Sonnet (repair mode)
"""

from __future__ import annotations

import time
from enum import Enum
from typing import Any

import anthropic
import httpx

from ..api.config import Settings


class ModelTier(str, Enum):
    OPUS = "opus"
    SONNET = "sonnet"
    HAIKU = "haiku"
    DEEPSEEK = "deepseek"


class TaskType(str, Enum):
    """Task types for intelligent model routing."""
    ARCHITECTURE = "architecture"
    BACKEND = "backend"
    DIFF = "diff"
    REPAIR = "repair"
    REVIEW = "review"
    UI_COMPONENT = "ui_component"
    STYLING = "styling"
    LAYOUT = "layout"
    SCAFFOLD = "scaffold"


# Task type → model tier routing
TASK_ROUTING: dict[TaskType, ModelTier] = {
    # Claude handles: architecture, backend, diffs, repair
    TaskType.ARCHITECTURE: ModelTier.OPUS,
    TaskType.BACKEND: ModelTier.SONNET,
    TaskType.DIFF: ModelTier.SONNET,
    TaskType.REPAIR: ModelTier.SONNET,
    TaskType.REVIEW: ModelTier.HAIKU,
    # DeepSeek handles: UI components, styling, layout
    TaskType.UI_COMPONENT: ModelTier.DEEPSEEK,
    TaskType.STYLING: ModelTier.DEEPSEEK,
    TaskType.LAYOUT: ModelTier.DEEPSEEK,
    TaskType.SCAFFOLD: ModelTier.DEEPSEEK,
}


def route_by_task(task_type: TaskType) -> ModelTier:
    """Get the appropriate model tier for a task type."""
    return TASK_ROUTING.get(task_type, ModelTier.SONNET)


def classify_file_task(file_path: str) -> TaskType:
    """Classify a file path into a task type for routing."""
    path_lower = file_path.lower()

    # UI/frontend files → DeepSeek
    if any(p in path_lower for p in [
        "/components/", "/pages/", "/app/page",
        ".css", ".scss", ".tailwind",
    ]):
        return TaskType.UI_COMPONENT

    if any(p in path_lower for p in [
        "layout", "globals.css", "theme", "styles",
    ]):
        return TaskType.STYLING

    # Backend/API files → Claude Sonnet
    if any(p in path_lower for p in [
        "/api/", "/services/", "/lib/", "/utils/",
        ".py", "route.ts", "middleware",
    ]):
        return TaskType.BACKEND

    # Types → Claude Sonnet (precision matters)
    if "/types" in path_lower or path_lower.endswith(".d.ts"):
        return TaskType.BACKEND

    # Default to UI for tsx/jsx files
    if path_lower.endswith((".tsx", ".jsx")):
        return TaskType.UI_COMPONENT

    return TaskType.BACKEND


# Cost per 1M tokens (USD) — update as pricing changes
COST_TABLE = {
    "opus":     {"input": 15.00, "output": 75.00},
    "sonnet":   {"input": 3.00,  "output": 15.00},
    "haiku":    {"input": 0.25,  "output": 1.25},
    "deepseek": {"input": 0.14,  "output": 0.28},
}

FALLBACK_CHAIN: dict[ModelTier, ModelTier] = {
    ModelTier.OPUS: ModelTier.SONNET,
    ModelTier.SONNET: ModelTier.DEEPSEEK,
    ModelTier.HAIKU: ModelTier.SONNET,
    ModelTier.DEEPSEEK: ModelTier.SONNET,
}

MAX_RETRIES = 3
RETRY_BACKOFF = [1, 2, 4]  # seconds


def call_llm(
    tier: ModelTier,
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int = 8192,
    temperature: float = 0.0,
) -> dict[str, Any]:
    """
    Route an LLM call to the appropriate provider with retry and fallback.

    Returns:
        {
            "content": str,        # response text
            "model": str,          # actual model used
            "tier": str,           # tier used (may differ from requested if fallback)
            "tokens_in": int,
            "tokens_out": int,
            "cost": float,         # USD
            "latency_ms": int,
        }
    """
    current_tier = tier

    for attempt in range(MAX_RETRIES + 1):
        try:
            start = time.monotonic()
            result = _dispatch(current_tier, messages, settings, max_tokens, temperature)
            latency = int((time.monotonic() - start) * 1000)

            tokens_in = result["tokens_in"]
            tokens_out = result["tokens_out"]
            cost_info = COST_TABLE[current_tier.value]
            cost = (tokens_in / 1_000_000 * cost_info["input"]) + (tokens_out / 1_000_000 * cost_info["output"])

            return {
                "content": result["content"],
                "model": result["model"],
                "tier": current_tier.value,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "cost": round(cost, 6),
                "latency_ms": latency,
            }

        except (anthropic.APIStatusError, anthropic.APIConnectionError, httpx.HTTPError) as e:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
                continue

            # All retries exhausted — try fallback
            fallback = FALLBACK_CHAIN.get(current_tier)
            if fallback and fallback != current_tier:
                current_tier = fallback
                continue

            raise RuntimeError(f"LLM call failed after {MAX_RETRIES} retries with fallback: {e}") from e


def _dispatch(
    tier: ModelTier,
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """Dispatch to the correct provider based on tier."""
    if tier in (ModelTier.OPUS, ModelTier.SONNET, ModelTier.HAIKU):
        return _call_anthropic(tier, messages, settings, max_tokens, temperature)
    elif tier == ModelTier.DEEPSEEK:
        return _call_deepseek(messages, settings, max_tokens, temperature)
    else:
        raise ValueError(f"Unknown model tier: {tier}")


def _call_anthropic(
    tier: ModelTier,
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """Call Anthropic API (Claude Opus/Sonnet/Haiku)."""
    model_map = {
        ModelTier.OPUS: settings.model_opus,
        ModelTier.SONNET: settings.model_sonnet,
        ModelTier.HAIKU: settings.model_haiku,
    }
    model_id = model_map[tier]

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)

    # Separate system message from user/assistant messages
    system_content = ""
    chat_messages = []
    for msg in messages:
        if msg["role"] == "system":
            system_content = msg["content"]
        else:
            chat_messages.append(msg)

    response = client.messages.create(
        model=model_id,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_content if system_content else anthropic.NOT_GIVEN,
        messages=chat_messages,
    )

    return {
        "content": response.content[0].text,
        "model": model_id,
        "tokens_in": response.usage.input_tokens,
        "tokens_out": response.usage.output_tokens,
    }


def _call_deepseek(
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """Call DeepSeek API (OpenAI-compatible endpoint)."""
    client = httpx.Client(timeout=120)

    response = client.post(
        "https://api.deepseek.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.deepseek_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.model_deepseek,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
    )
    response.raise_for_status()
    data = response.json()

    choice = data["choices"][0]
    usage = data.get("usage", {})

    return {
        "content": choice["message"]["content"],
        "model": settings.model_deepseek,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }
