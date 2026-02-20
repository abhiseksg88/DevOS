"""
Figma API Client — Server-side Python integration for the agent pipeline.

Fetches Figma file JSON, parses the node tree, and converts it into a
Design Contract that the frontend agent can consume directly.

Design Contract format:
  {
    "file_name": str,
    "last_modified": str,
    "screens": [
      {
        "name": str,              # Frame/page name (e.g. "Dashboard", "Contacts")
        "components": [
          {
            "id": str,            # Figma node ID
            "name": str,          # Designer-assigned name
            "type": str,          # "button"|"input"|"form"|"card"|"table"|"nav"|"layout"|"text"|"image"
            "tailwind": str,      # Inferred Tailwind classes
            "children": [...]     # Nested components
          }
        ]
      }
    ],
    "design_tokens": {
      "primary_color": str,      # Tailwind token (e.g. "bg-brand-500")
      "font_sizes": [str],
      "spacing": str,            # "compact"|"normal"|"spacious"
    }
  }

The agent pipeline calls fetch_design_contract(figma_key, settings) to
get the full design contract for a build.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ..api.config import Settings

logger = logging.getLogger(__name__)

FIGMA_API = "https://api.figma.com/v1"


# ---------------------------------------------------------------------------
# Component type detection (ported from frontend/src/lib/figma-mapper.ts)
# ---------------------------------------------------------------------------

def _detect_component_type(node: dict[str, Any]) -> str:
    """Classify a Figma node into a UI component type."""
    name = (node.get("name") or "").lower()
    node_type = (node.get("type") or "").upper()
    children = node.get("children") or []

    if node_type == "TEXT":
        return "text"

    if node_type in ("RECTANGLE", "ELLIPSE", "VECTOR"):
        if any(k in name for k in ("image", "img", "photo", "avatar", "icon", "logo")):
            return "image"

    if any(k in name for k in ("button", "btn", "cta", "submit", "action")):
        return "button"
    if any(k in name for k in ("input", "field", "text-input", "search", "textfield")):
        return "input"
    if any(k in name for k in ("form", "sign", "login", "register", "checkout")):
        return "form"
    if any(k in name for k in ("card", "tile", "item", "product", "feature")):
        return "card"
    if any(k in name for k in ("table", "grid", "list", "datatable", "spreadsheet")):
        return "table"
    if any(k in name for k in ("nav", "header", "sidebar", "footer", "menu", "tab", "breadcrumb")):
        return "nav"
    if any(k in name for k in ("modal", "dialog", "popup", "overlay", "drawer")):
        return "modal"
    if any(k in name for k in ("chart", "graph", "analytics", "metric", "kpi")):
        return "chart"

    if node_type in ("FRAME", "COMPONENT", "INSTANCE", "GROUP"):
        # Check if frame looks like a form (≥2 input children)
        input_children = sum(1 for c in children if _detect_component_type(c) == "input")
        if input_children >= 2:
            return "form"
        # Card heuristic: moderate children, bounded size
        box = node.get("absoluteBoundingBox") or {}
        if 2 <= len(children) <= 8 and box.get("width", 999) < 600 and box.get("height", 999) < 700:
            return "card"
        return "layout"

    return "unknown"


def _map_color(r: int, g: int, b: int) -> str:
    """Map RGB values to the nearest Tailwind design token."""
    # Brand purple (#8b5cf6)
    if abs(r - 139) < 30 and abs(g - 92) < 30 and abs(b - 246) < 30:
        return "brand-500"
    if r < 40 and g < 40 and b < 50:
        return "slate-900"
    if r < 60 and g < 60 and b < 70:
        return "slate-800"
    if r > 240 and g > 240 and b > 240:
        return "white"
    if r > 220 and g > 220 and b > 220:
        return "slate-100"
    if abs(r - g) < 15 and abs(g - b) < 15:
        if r > 180:
            return "slate-200"
        if r > 120:
            return "slate-500"
        return "slate-700"
    if g > r + 40 and g > b + 20:
        return "emerald-500"
    if r > g + 50 and r > b + 50:
        return "red-500"
    if r > 200 and g > 150 and b < 100:
        return "amber-500"
    return "slate-600"


def _extract_tailwind(node: dict[str, Any]) -> str:
    """Generate Tailwind class hints from Figma style properties."""
    classes: list[str] = []

    fills = node.get("fills") or []
    if fills and fills[0].get("color"):
        c = fills[0]["color"]
        token = _map_color(
            round(c.get("r", 0) * 255),
            round(c.get("g", 0) * 255),
            round(c.get("b", 0) * 255),
        )
        classes.append(f"bg-{token}")

    font_size = node.get("style", {}).get("fontSize") if node.get("style") else None
    if font_size:
        size_map = {10: "text-xs", 12: "text-xs", 14: "text-sm", 16: "text-base",
                    18: "text-lg", 20: "text-xl", 24: "text-2xl", 30: "text-3xl"}
        for threshold, cls in sorted(size_map.items()):
            if font_size <= threshold:
                classes.append(cls)
                break
        else:
            classes.append("text-4xl")

    radius = node.get("cornerRadius")
    if radius:
        if radius <= 4:
            classes.append("rounded")
        elif radius <= 8:
            classes.append("rounded-lg")
        elif radius <= 16:
            classes.append("rounded-2xl")
        else:
            classes.append("rounded-full")

    effects = node.get("effects") or []
    if any(e.get("type") == "DROP_SHADOW" for e in effects):
        classes.append("shadow-md")

    return " ".join(classes)


def _parse_node(node: dict[str, Any], depth: int = 0) -> dict[str, Any] | None:
    """Recursively parse a Figma node into a component spec."""
    if depth > 4:
        return None

    component_type = _detect_component_type(node)
    if component_type == "unknown" and depth > 1:
        return None

    children_nodes = []
    for child in (node.get("children") or []):
        parsed = _parse_node(child, depth + 1)
        if parsed:
            children_nodes.append(parsed)

    return {
        "id": node.get("id", ""),
        "name": node.get("name", ""),
        "type": component_type,
        "tailwind": _extract_tailwind(node),
        "children": children_nodes,
    }


def _extract_screens(document: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract top-level frames (screens/pages) from the Figma document."""
    screens = []
    pages = document.get("children") or []

    for page in pages:
        page_name = page.get("name", "Page")
        frames = page.get("children") or []

        for frame in frames:
            frame_type = (frame.get("type") or "").upper()
            if frame_type not in ("FRAME", "COMPONENT", "GROUP"):
                continue

            components = []
            for child in (frame.get("children") or []):
                parsed = _parse_node(child, depth=1)
                if parsed and parsed["type"] != "unknown":
                    components.append(parsed)

            if components or frame_type == "FRAME":
                screens.append({
                    "name": frame.get("name", page_name),
                    "page": page_name,
                    "components": components,
                    "bounds": frame.get("absoluteBoundingBox", {}),
                })

    return screens


def _extract_design_tokens(document: dict[str, Any]) -> dict[str, Any]:
    """Infer global design tokens from the Figma document."""
    # Collect all text font sizes and background colors
    font_sizes: list[float] = []
    bg_colors: list[str] = []

    def _walk(node: dict[str, Any]) -> None:
        style = node.get("style") or {}
        if style.get("fontSize"):
            font_sizes.append(style["fontSize"])
        fills = node.get("fills") or []
        if fills and fills[0].get("color"):
            c = fills[0]["color"]
            bg_colors.append(_map_color(
                round(c.get("r", 0) * 255),
                round(c.get("g", 0) * 255),
                round(c.get("b", 0) * 255),
            ))
        for child in node.get("children") or []:
            _walk(child)

    _walk(document)

    # Most frequent bg color = primary accent
    primary = "brand-500"
    if bg_colors:
        from collections import Counter
        most_common = Counter(bg_colors).most_common(3)
        non_neutral = [c for c, _ in most_common
                       if not any(k in c for k in ("slate", "white", "gray"))]
        if non_neutral:
            primary = non_neutral[0]

    # Detect spacing density from bounding box sizes
    spacing = "normal"

    # Unique font sizes → tailwind tokens
    tailwind_sizes = []
    size_map = [(10, "xs"), (12, "xs"), (14, "sm"), (16, "base"),
                (18, "lg"), (20, "xl"), (24, "2xl"), (30, "3xl"), (9999, "4xl")]
    for fs in sorted(set(int(f) for f in font_sizes))[:6]:
        for threshold, label in size_map:
            if fs <= threshold:
                tailwind_sizes.append(f"text-{label}")
                break

    return {
        "primary_color": f"bg-{primary}",
        "font_sizes": tailwind_sizes or ["text-sm", "text-base", "text-lg"],
        "spacing": spacing,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fetch_design_contract(figma_key: str, settings: Settings) -> dict[str, Any]:
    """
    Fetch a Figma file and convert it to a Design Contract for the agent pipeline.

    Args:
        figma_key: Figma file key (alphanumeric ID from URL)
        settings: App settings (uses settings.figma_access_token)

    Returns:
        Design Contract dict with screens, components, and design tokens.

    Raises:
        ValueError: If figma_access_token not configured
        httpx.HTTPStatusError: If Figma API request fails
    """
    if not settings.figma_access_token:
        raise ValueError(
            "FIGMA_ACCESS_TOKEN not configured. "
            "Set it in .env or project integrations to use Figma import."
        )

    logger.info("Fetching Figma file %s...", figma_key[:8])
    client = httpx.Client(timeout=60)

    resp = client.get(
        f"{FIGMA_API}/files/{figma_key}",
        headers={"X-Figma-Token": settings.figma_access_token},
    )
    resp.raise_for_status()
    data = resp.json()

    document = data.get("document", {})
    screens = _extract_screens(document)
    tokens = _extract_design_tokens(document)

    logger.info("Parsed %d screens from Figma file '%s'", len(screens), data.get("name", "?"))

    return {
        "file_name": data.get("name", "Untitled"),
        "last_modified": data.get("lastModified", ""),
        "figma_key": figma_key,
        "screens": screens,
        "design_tokens": tokens,
    }


def extract_figma_key(url_or_key: str) -> str:
    """Extract the file key from a Figma URL or return the raw key."""
    import re
    match = re.search(r"figma\.com/(?:design|file|proto)/([a-zA-Z0-9_-]+)", url_or_key)
    if match:
        return match.group(1)
    return url_or_key.strip()
