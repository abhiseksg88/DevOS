"""
LLM Router — Three-layer multi-model routing with fallback and cost tracking.

THREE-LAYER ARCHITECTURE:
  ┌─────────────────────────────────────────────────────────┐
  │  Layer 1 — GPT-4o  (The Communicator)                    │
  │  JSON output, structured specs, user-facing reasoning    │
  │  Tasks: requirements, design contract, HITL commentary   │
  ├─────────────────────────────────────────────────────────┤
  │  Layer 2 — Gemini  (The Analyst)                         │
  │  Large content, 1M-token codebase context, vision        │
  │  Tasks: frontend code, backend spec, codebase analysis   │
  │         wireframe vision, fast pre-review                │
  ├─────────────────────────────────────────────────────────┤
  │  Layer 3 — Claude  (The Engineer)                        │
  │  Code precision, security, surgical diff patches         │
  │  Tasks: integration, review, repair, architecture        │
  └─────────────────────────────────────────────────────────┘

Fallback chain:
  GPT-4o       → Opus    (JSON spec fails → Claude structural planning)
  Gemini Pro   → Opus    (content fails → Claude deep planning)
  Gemini Flash → Haiku   (fast review fails → Claude fast review)
  Opus         → Sonnet  (planning fails → degraded planning)
  Haiku        → Sonnet  (fast task fails → reliable anchor)
  Sonnet       → (none)  (anchor tier; RuntimeError on exhaustion)

Note: DeepSeek is retained in the cost table and fallback map for
historical cost tracking but is no longer used as a primary model.
Claude Haiku replaced it — better instruction-following eliminates
the LOC violations and TODO leaks that caused the review retry loop.
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
    GPT4O = "gpt4o"               # OpenAI GPT-4o for requirements + vision
    GEMINI_PRO = "gemini_pro"     # Gemini 2.0 Pro: 1M-token full codebase context
    GEMINI_FLASH = "gemini_flash" # Gemini 2.0 Flash: fast cheap pre-review + routing


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

    # ── LAYER 1: GPT-4o  — The Communicator ──────────────────────────────
    # JSON output, structured specs, user-facing reasoning
    REQUIREMENTS = "requirements"           # Natural language → structured PRD JSON
    DESIGN = "design"                       # PRD → Design Contract JSON (spec, not code)
    HITL_COMMENTARY = "hitl_commentary"     # Technical plan → friendly user explanation

    # ── LAYER 2: Gemini  — The Analyst ───────────────────────────────────
    # Large content volume, 1M-token codebase context, vision
    FRONTEND = "frontend"                   # Full UI code generation (large volume + vision)
    BACKEND_SPEC = "backend_spec"           # Backend schema from full codebase context
    CODEBASE_ANALYSIS = "codebase_analysis" # Entire codebase ingest + impact analysis (1M ctx)
    VISION = "vision"                       # Wireframe/screenshot → UI spec
    PRE_REVIEW = "pre_review"               # Fast critical-issue gate (40x cheaper)

    # ── LAYER 3: Claude  — The Engineer ──────────────────────────────────
    # Code precision, security, surgical diffs
    INTEGRATION = "integration"             # Replace mocks with Supabase (surgical patches)
    BACKEND = "backend"
    DIFF = "diff"
    REPAIR = "repair"
    REVIEW = "review"


# ═══════════════════════════════════════════════════════════════════════════
# THREE-LAYER ROUTING TABLE
# ═══════════════════════════════════════════════════════════════════════════
#
#  GPT-4o   — Communicator: JSON specs, user reasoning, structured output
#  Gemini   — Analyst:      Content volume, codebase context (1M), vision
#  Claude   — Engineer:     Code precision, security, surgical patches
#
TASK_ROUTING: dict[TaskType, ModelTier] = {

    # ── Layer 1: GPT-4o (Communicator) ───────────────────────────────────
    # Best at: structured JSON, product language, user-facing clarity
    TaskType.REQUIREMENTS:    ModelTier.GPT4O,   # PRD JSON
    TaskType.DESIGN:          ModelTier.GPT4O,   # Design Contract JSON (specs, not code)
    TaskType.HITL_COMMENTARY: ModelTier.GPT4O,   # HITL plan → friendly user message

    # ── Layer 2: Gemini (Analyst) ─────────────────────────────────────────
    # Best at: 1M context, large code volume, vision, ultra-fast pre-review
    TaskType.FRONTEND:           ModelTier.GEMINI_PRO,   # Full UI code (large, vision-aware)
    TaskType.BACKEND_SPEC:       ModelTier.GEMINI_PRO,   # Backend from full codebase context
    TaskType.CODEBASE_ANALYSIS:  ModelTier.GEMINI_PRO,   # Full codebase ingest (1M tokens)
    TaskType.VISION:             ModelTier.GEMINI_PRO,   # Wireframe/screenshot → spec
    TaskType.PRE_REVIEW:         ModelTier.GEMINI_FLASH, # Fast critical-issue gate

    # ── Layer 3: Claude (Engineer) ────────────────────────────────────────
    # Best at: precise code, OWASP security, instruction-following for diffs
    TaskType.ARCHITECTURE: ModelTier.OPUS,     # Deep architectural planning
    TaskType.INTEGRATION:  ModelTier.SONNET,   # Surgical mock→Supabase patches
    TaskType.BACKEND:      ModelTier.SONNET,   # Backend API code
    TaskType.DIFF:         ModelTier.SONNET,   # Unified diffs
    TaskType.REPAIR:       ModelTier.SONNET,   # Fix specific issues
    TaskType.REVIEW:       ModelTier.SONNET,   # Security + pattern review
    # Haiku: fast, cheap UI scaffolding
    TaskType.UI_COMPONENT: ModelTier.HAIKU,
    TaskType.STYLING:      ModelTier.HAIKU,
    TaskType.LAYOUT:       ModelTier.HAIKU,
    TaskType.SCAFFOLD:     ModelTier.HAIKU,
}


def route_by_task(task_type: TaskType) -> ModelTier:
    """Get the appropriate model tier for a task type."""
    return TASK_ROUTING.get(task_type, ModelTier.SONNET)


def classify_file_task(file_path: str) -> TaskType:
    """Classify a file path into a task type for routing."""
    path_lower = file_path.lower()

    # UI/frontend files → Haiku
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
    "opus":          {"input": 15.00, "output": 75.00},
    "sonnet":        {"input": 3.00,  "output": 15.00},
    "haiku":         {"input": 0.25,  "output": 1.25},
    "deepseek":      {"input": 0.14,  "output": 0.28},
    "gpt4o":         {"input": 2.50,  "output": 10.00},   # GPT-4o pricing
    "gemini_pro":    {"input": 1.25,  "output": 5.00},    # Gemini 2.0 Pro (1M ctx window)
    "gemini_flash":  {"input": 0.075, "output": 0.30},    # Gemini 2.0 Flash (ultra-cheap)
}

FALLBACK_CHAIN: dict[ModelTier, ModelTier] = {
    ModelTier.GPT4O:        ModelTier.OPUS,      # GPT-4o fails → Opus (requirements → Claude)
    ModelTier.GEMINI_PRO:   ModelTier.OPUS,      # Gemini Pro fails → Opus (architecture fallback)
    ModelTier.GEMINI_FLASH: ModelTier.HAIKU,     # Gemini Flash fails → Haiku (fast fallback)
    ModelTier.OPUS:         ModelTier.SONNET,    # Opus fails → Sonnet (degraded planning)
    ModelTier.HAIKU:        ModelTier.SONNET,    # Haiku fails → Sonnet (over-qualified but reliable)
    ModelTier.DEEPSEEK:     ModelTier.SONNET,    # DeepSeek retained as dead fallback
    # SONNET has no fallback — it is the anchor tier; if it fails, raise RuntimeError
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

    Each tier gets up to MAX_RETRIES attempts.  When a tier exhausts all
    retries the fallback chain is consulted and the counter resets — so the
    fallback tier is always actually tried (unlike the previous `for` loop
    implementation where `continue` at the last iteration silently exited).

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
    attempt = 0

    while True:
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

        except (RuntimeError, ValueError) as _cfg_err:
            # Provider not configured (missing API key) or unknown tier — skip retries, go straight to fallback.
            fallback = FALLBACK_CHAIN.get(current_tier)
            if fallback and fallback != current_tier:
                logging.getLogger(__name__).warning(
                    "Provider %s unavailable (%s) — falling back to %s",
                    current_tier.value, _cfg_err, fallback.value,
                )
                current_tier = fallback
                attempt = 0
                continue
            raise

        except (anthropic.APIStatusError, anthropic.APIConnectionError, httpx.HTTPError, OSError) as e:
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)])
                attempt += 1
                continue

            # All retries for current_tier exhausted — try fallback tier
            fallback = FALLBACK_CHAIN.get(current_tier)
            if fallback and fallback != current_tier:
                current_tier = fallback
                attempt = 0   # reset retry counter for the new tier
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
    elif tier == ModelTier.GPT4O:
        return _call_openai(messages, settings, max_tokens, temperature)
    elif tier in (ModelTier.GEMINI_PRO, ModelTier.GEMINI_FLASH):
        return _call_gemini(tier, messages, settings, max_tokens, temperature)
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


def _call_openai(
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """Call OpenAI API (GPT-4o) for requirements analysis."""
    if not settings.openai_api_key:
        raise RuntimeError(
            "OPENAI_API_KEY not configured. Set it in .env to enable requirements analysis."
        )

    response = httpx.Client(timeout=120).post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.openai_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": settings.model_gpt4o,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "response_format": {"type": "text"},
        },
    )
    response.raise_for_status()
    data = response.json()

    if "choices" not in data or not data["choices"]:
        error_msg = data.get("error", {}).get("message", str(data)[:200])
        raise httpx.HTTPStatusError(
            f"OpenAI returned no choices: {error_msg}",
            request=response.request,
            response=response,
        )

    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {
        "content": choice["message"]["content"],
        "model": settings.model_gpt4o,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }


def _call_gemini(
    tier: ModelTier,
    messages: list[dict[str, str]],
    settings: Settings,
    max_tokens: int,
    temperature: float,
) -> dict[str, Any]:
    """
    Call Google Gemini API (Pro or Flash) via the OpenAI-compatible endpoint.

    Gemini Pro:   1M token context → ingest entire codebase at once
    Gemini Flash: Ultra-fast, ultra-cheap → pre-review, routing, simple tasks

    Uses the OpenAI-compatible endpoint so no extra SDK needed beyond httpx.
    """
    if not settings.gemini_api_key:
        raise RuntimeError(
            "GEMINI_API_KEY not configured. Set it in .env to enable Gemini integration."
        )

    model_map = {
        ModelTier.GEMINI_PRO: settings.model_gemini_pro,
        ModelTier.GEMINI_FLASH: settings.model_gemini_flash,
    }
    model_id = model_map[tier]

    # Gemini supports OpenAI-compatible API at generativelanguage.googleapis.com
    response = httpx.Client(timeout=180).post(
        f"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        headers={
            "Authorization": f"Bearer {settings.gemini_api_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": model_id,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        },
    )
    response.raise_for_status()
    data = response.json()

    if "choices" not in data or not data["choices"]:
        error_msg = data.get("error", {}).get("message", str(data)[:200])
        raise httpx.HTTPStatusError(
            f"Gemini returned no choices: {error_msg}",
            request=response.request,
            response=response,
        )

    choice = data["choices"][0]
    usage = data.get("usage", {})
    return {
        "content": choice["message"]["content"],
        "model": model_id,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
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

    # DeepSeek can return a 200 with an error body (no "choices") — treat that
    # as an HTTP error so the retry/fallback logic in call_llm picks it up.
    if "choices" not in data or not data["choices"]:
        error_msg = data.get("error", {}).get("message", str(data)[:200])
        raise httpx.HTTPStatusError(
            f"DeepSeek returned no choices: {error_msg}",
            request=response.request,
            response=response,
        )

    choice = data["choices"][0]
    usage = data.get("usage", {})

    return {
        "content": choice["message"]["content"],
        "model": settings.model_deepseek,
        "tokens_in": usage.get("prompt_tokens", 0),
        "tokens_out": usage.get("completion_tokens", 0),
    }
