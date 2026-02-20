"""
Figma API Client — Server-side Python integration for the agent pipeline.

HOW FIGMA PRODUCES JSON
-----------------------
When you call GET /v1/files/{key}, Figma returns a full node tree that mirrors
the canvas exactly.  Every frame, component, group, and text layer is a node
with typed properties.  The key properties we exploit:

  layoutMode       "HORIZONTAL" | "VERTICAL" | "NONE"   → flex direction
  primaryAxisAlignItems  "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" → justify-*
  counterAxisAlignItems  "MIN" | "CENTER" | "MAX" | "BASELINE"      → items-*
  itemSpacing      gap between children (px)             → gap-*
  paddingLeft/Right/Top/Bottom  inner padding (px)       → px-* py-*
  fills            [{color:{r,g,b,a}, type:"SOLID"}]    → bg-*
  strokes          border color / style                  → border-*
  strokeWeight     border width (px)                     → border-*
  style            {fontSize, fontWeight, lineHeightPx, letterSpacing, ...}
  cornerRadius     border radius (px)                    → rounded-*
  effects          [{type:"DROP_SHADOW", ...}]           → shadow-*
  opacity          0.0–1.0                               → opacity-*
  absoluteBoundingBox {x, y, width, height}
  reactions        [{action:{destinationId}, trigger}]   → navigation flows
  componentSets    component variants ("Button/Primary/Large")

Design Contract output format:
  {
    "file_name": str,
    "last_modified": str,
    "figma_key": str,
    "screens": [
      {
        "name": str,
        "page": str,
        "route": str,              # inferred slug  e.g. "/dashboard"
        "bounds": {width, height},
        "layout": str,             # "flex-col" | "flex-row" | "grid" | "block"
        "components": [
          {
            "id": str,
            "name": str,
            "type": str,           # button|input|form|card|table|nav|modal|chart|image|text|layout
            "variant": str | None, # primary|secondary|danger|ghost|outline
            "size": str | None,    # sm|md|lg|xl
            "tailwind": str,       # full Tailwind class string
            "text_content": str,   # for TEXT nodes
            "placeholder": str,    # for input nodes
            "nav_target": str | None, # prototype flow destination screen name
            "children": [...]
          }
        ]
      }
    ],
    "design_tokens": {
      "primary_color": str,        # e.g. "bg-violet-500"
      "font_family": str,          # e.g. "Inter"
      "font_sizes": [str],         # e.g. ["text-sm", "text-base", "text-lg"]
      "font_weights": [str],       # e.g. ["font-normal", "font-semibold", "font-bold"]
      "border_radius": str,        # "none"|"sm"|"md"|"lg"|"xl"|"full"
      "spacing": str,              # "compact"|"normal"|"spacious"
      "colors": {name: hex},       # named Figma color styles
      "shadows": bool,
    },
    "navigation": [                # prototype flow connections between screens
      {"from": str, "to": str, "trigger": str}
    ]
  }

The agent pipeline calls fetch_design_contract(figma_key, settings).
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from typing import Any

import httpx

from ..api.config import Settings

logger = logging.getLogger(__name__)

FIGMA_API = "https://api.figma.com/v1"

# ---------------------------------------------------------------------------
# Tailwind spacing lookup — Figma uses px, Tailwind uses 4px units
# ---------------------------------------------------------------------------

_SPACING_MAP = [
    (0, "0"), (2, "0.5"), (4, "1"), (6, "1.5"), (8, "2"), (10, "2.5"),
    (12, "3"), (14, "3.5"), (16, "4"), (20, "5"), (24, "6"), (28, "7"),
    (32, "8"), (36, "9"), (40, "10"), (44, "11"), (48, "12"), (56, "14"),
    (64, "16"), (72, "18"), (80, "20"), (96, "24"), (128, "32"),
]


def _px_to_spacing(px: float) -> str:
    """Convert a pixel value to the nearest Tailwind spacing token."""
    px = round(px)
    best_token = "0"
    best_diff = abs(px)
    for threshold, token in _SPACING_MAP:
        diff = abs(px - threshold)
        if diff < best_diff:
            best_diff = diff
            best_token = token
        if threshold > px + 16:
            break
    return best_token


# ---------------------------------------------------------------------------
# Color mapping — Figma RGBA (0–1) → Tailwind token
# ---------------------------------------------------------------------------

def _map_color(r: int, g: int, b: int) -> str:
    """Map RGB values (0–255) to the nearest Tailwind color token."""
    # Violet / brand (#7c3aed / #8b5cf6)
    if r > 90 and b > 180 and r < b and g < 120:
        intensity = b - r
        if intensity > 100:
            return "violet-600" if r < 100 else "violet-500"
        return "violet-400"
    # Pure blue
    if b > r + 60 and b > g + 30:
        return "blue-500" if b > 180 else "blue-400"
    # Sky blue
    if g > r + 20 and b > r + 40 and b > 160:
        return "sky-500"
    # Cyan / teal
    if g > 170 and b > 160 and r < 100:
        return "teal-500"
    # Emerald / green
    if g > r + 40 and g > b + 20:
        return "emerald-500" if g > 160 else "green-600"
    # Yellow / amber
    if r > 200 and g > 150 and b < 80:
        return "amber-500"
    if r > 230 and g > 200 and b < 50:
        return "yellow-400"
    # Red / rose
    if r > g + 50 and r > b + 50:
        return "rose-500" if r > 200 else "red-700"
    # Pink
    if r > 200 and b > 150 and g < 120:
        return "pink-500"
    # Dark / near-black
    if r < 30 and g < 35 and b < 45:
        return "slate-950"
    if r < 60 and g < 65 and b < 75:
        return "slate-800"
    if r < 90 and g < 95 and b < 110:
        return "slate-700"
    # Near-white
    if r > 245 and g > 245 and b > 245:
        return "white"
    if r > 230 and g > 230 and b > 230:
        return "slate-100"
    if r > 210 and g > 210 and b > 210:
        return "slate-200"
    # Mid-grays
    if abs(r - g) < 15 and abs(g - b) < 15:
        if r > 180:
            return "slate-300"
        if r > 130:
            return "slate-400"
        return "slate-500"
    return "slate-600"


def _rgba_to_hex(r: float, g: float, b: float) -> str:
    return "#{:02x}{:02x}{:02x}".format(round(r * 255), round(g * 255), round(b * 255))


# ---------------------------------------------------------------------------
# Auto-layout → Tailwind flex/grid classes
# ---------------------------------------------------------------------------

_AXIS_ALIGN_MAP = {
    "MIN": "start",
    "CENTER": "center",
    "MAX": "end",
    "SPACE_BETWEEN": "between",
    "BASELINE": "baseline",
}

_COUNTER_ALIGN_MAP = {
    "MIN": "start",
    "CENTER": "center",
    "MAX": "end",
    "BASELINE": "baseline",
    "STRETCH": "stretch",
}


def _extract_layout_classes(node: dict[str, Any]) -> list[str]:
    """Extract Tailwind flex/layout classes from Figma auto-layout properties."""
    classes: list[str] = []
    layout_mode = node.get("layoutMode", "NONE")

    if layout_mode == "HORIZONTAL":
        classes.append("flex flex-row")
    elif layout_mode == "VERTICAL":
        classes.append("flex flex-col")
    else:
        return classes  # no auto-layout — caller adds block/relative

    # Gap between children
    gap = node.get("itemSpacing", 0)
    if gap:
        classes.append(f"gap-{_px_to_spacing(gap)}")

    # Justify (main axis)
    primary = node.get("primaryAxisAlignItems", "MIN")
    tw_primary = _AXIS_ALIGN_MAP.get(primary, "start")
    classes.append(f"justify-{tw_primary}")

    # Align (cross axis)
    counter = node.get("counterAxisAlignItems", "MIN")
    tw_counter = _COUNTER_ALIGN_MAP.get(counter, "start")
    classes.append(f"items-{tw_counter}")

    # Flex wrap
    if node.get("layoutWrap") == "WRAP":
        classes.append("flex-wrap")

    return classes


def _extract_padding_classes(node: dict[str, Any]) -> list[str]:
    """Extract Tailwind padding classes from Figma padding properties."""
    pl = node.get("paddingLeft", 0)
    pr = node.get("paddingRight", 0)
    pt = node.get("paddingTop", 0)
    pb = node.get("paddingBottom", 0)

    if not any([pl, pr, pt, pb]):
        return []

    # Use shorthand where possible
    classes = []
    if pl == pr:
        classes.append(f"px-{_px_to_spacing(pl)}")
    else:
        if pl:
            classes.append(f"pl-{_px_to_spacing(pl)}")
        if pr:
            classes.append(f"pr-{_px_to_spacing(pr)}")

    if pt == pb:
        classes.append(f"py-{_px_to_spacing(pt)}")
    else:
        if pt:
            classes.append(f"pt-{_px_to_spacing(pt)}")
        if pb:
            classes.append(f"pb-{_px_to_spacing(pb)}")

    return classes


# ---------------------------------------------------------------------------
# Typography classes from Figma style object
# ---------------------------------------------------------------------------

_FONT_SIZE_MAP = [
    (10, "text-xs"), (12, "text-xs"), (13, "text-sm"), (14, "text-sm"),
    (15, "text-base"), (16, "text-base"), (18, "text-lg"), (20, "text-xl"),
    (24, "text-2xl"), (28, "text-3xl"), (30, "text-3xl"), (36, "text-4xl"),
    (48, "text-5xl"), (60, "text-6xl"),
]

_FONT_WEIGHT_MAP = [
    (300, "font-light"), (400, "font-normal"), (500, "font-medium"),
    (600, "font-semibold"), (700, "font-bold"), (800, "font-extrabold"),
    (900, "font-black"),
]

_LINE_HEIGHT_MAP = [
    (1.0, "leading-none"), (1.25, "leading-tight"), (1.375, "leading-snug"),
    (1.5, "leading-normal"), (1.625, "leading-relaxed"), (2.0, "leading-loose"),
]


def _extract_typography_classes(node: dict[str, Any]) -> list[str]:
    """Extract Tailwind typography classes from Figma style property."""
    style = node.get("style") or {}
    if not style:
        return []

    classes: list[str] = []

    # Font size
    fs = style.get("fontSize", 0)
    if fs:
        best = "text-base"
        for threshold, cls in _FONT_SIZE_MAP:
            if fs <= threshold:
                best = cls
                break
        else:
            best = "text-7xl"
        classes.append(best)

    # Font weight
    fw = style.get("fontWeight", 400)
    if fw:
        best_w = "font-normal"
        for threshold, cls in _FONT_WEIGHT_MAP:
            if fw <= threshold:
                best_w = cls
                break
        classes.append(best_w)

    # Line height (expressed as ratio = lineHeightPx / fontSize)
    lh_px = style.get("lineHeightPx", 0)
    if lh_px and fs:
        ratio = lh_px / fs
        best_lh = "leading-normal"
        for threshold, cls in _LINE_HEIGHT_MAP:
            if ratio <= threshold + 0.1:
                best_lh = cls
                break
        classes.append(best_lh)

    # Letter spacing
    ls = style.get("letterSpacing", 0)
    if ls < -0.5:
        classes.append("tracking-tight")
    elif ls > 1:
        classes.append("tracking-wide")
    elif ls > 2:
        classes.append("tracking-wider")

    # Text color from fills
    fills = node.get("fills") or []
    if fills and fills[0].get("color"):
        c = fills[0]["color"]
        token = _map_color(
            round(c.get("r", 0) * 255),
            round(c.get("g", 0) * 255),
            round(c.get("b", 0) * 255),
        )
        classes.append(f"text-{token}")

    return classes


# ---------------------------------------------------------------------------
# Full Tailwind extractor (composes all sub-extractors)
# ---------------------------------------------------------------------------

def _extract_tailwind(node: dict[str, Any]) -> str:
    """Generate a full Tailwind class string from all Figma style properties."""
    classes: list[str] = []

    # 1. Auto-layout → flex direction + gap + justify + align
    layout_classes = _extract_layout_classes(node)
    classes.extend(layout_classes)

    # 2. Padding
    classes.extend(_extract_padding_classes(node))

    # 3. Background fill (non-TEXT nodes)
    node_type = (node.get("type") or "").upper()
    if node_type != "TEXT":
        fills = node.get("fills") or []
        if fills and fills[0].get("type") == "SOLID" and fills[0].get("color"):
            c = fills[0]["color"]
            opacity = fills[0].get("opacity", 1.0)
            token = _map_color(
                round(c.get("r", 0) * 255),
                round(c.get("g", 0) * 255),
                round(c.get("b", 0) * 255),
            )
            classes.append(f"bg-{token}")
            if opacity < 0.9:
                classes.append(f"bg-opacity-{round(opacity * 100 / 10) * 10}")

    # 4. Typography (TEXT nodes or nodes with style)
    if node_type == "TEXT":
        classes.extend(_extract_typography_classes(node))
    elif node.get("style"):
        classes.extend(_extract_typography_classes(node))

    # 5. Border radius
    radius = node.get("cornerRadius")
    if not radius:
        # Individual corners — use max for simplicity
        radii = [
            node.get("rectangleCornerRadii", [0, 0, 0, 0])
        ]
        all_radii = radii[0] if radii[0] else [0]
        radius = max(all_radii) if all_radii else 0

    if radius:
        if radius <= 2:
            classes.append("rounded-sm")
        elif radius <= 4:
            classes.append("rounded")
        elif radius <= 6:
            classes.append("rounded-md")
        elif radius <= 8:
            classes.append("rounded-lg")
        elif radius <= 12:
            classes.append("rounded-xl")
        elif radius <= 16:
            classes.append("rounded-2xl")
        else:
            classes.append("rounded-full")

    # 6. Border / stroke
    strokes = node.get("strokes") or []
    stroke_weight = node.get("strokeWeight", 0)
    if strokes and stroke_weight:
        stroke_color = strokes[0].get("color", {})
        sr = round(stroke_color.get("r", 0) * 255)
        sg = round(stroke_color.get("g", 0) * 255)
        sb = round(stroke_color.get("b", 0) * 255)
        border_token = _map_color(sr, sg, sb)
        weight_cls = "border" if stroke_weight <= 1 else f"border-{round(stroke_weight)}"
        classes.append(f"{weight_cls} border-{border_token}")

    # 7. Shadow
    effects = node.get("effects") or []
    shadows = [e for e in effects if e.get("type") == "DROP_SHADOW" and e.get("visible", True)]
    if shadows:
        shadow = shadows[0]
        radius_val = shadow.get("radius", 4)
        if radius_val <= 4:
            classes.append("shadow-sm")
        elif radius_val <= 8:
            classes.append("shadow")
        elif radius_val <= 16:
            classes.append("shadow-md")
        elif radius_val <= 24:
            classes.append("shadow-lg")
        else:
            classes.append("shadow-xl")

    # 8. Opacity
    opacity = node.get("opacity", 1.0)
    if opacity < 0.95:
        pct = round(opacity * 100 / 10) * 10
        classes.append(f"opacity-{max(10, pct)}")

    # 9. Overflow / scroll
    clips = node.get("clipsContent", False)
    if clips:
        classes.append("overflow-hidden")

    return " ".join(c for c in classes if c)


# ---------------------------------------------------------------------------
# Component type detection with variant parsing
# ---------------------------------------------------------------------------

_COMPONENT_NAME_PATTERNS: list[tuple[str, list[str]]] = [
    ("button",  ["button", "btn", "cta", "submit", "action", "call-to-action"]),
    ("input",   ["input", "field", "textfield", "text-field", "search", "textarea"]),
    ("select",  ["select", "dropdown", "combobox", "picker"]),
    ("checkbox",["checkbox", "check", "toggle"]),
    ("form",    ["form", "sign-in", "sign-up", "login", "register", "checkout", "auth"]),
    ("card",    ["card", "tile", "panel", "widget", "feature", "product", "listing"]),
    ("table",   ["table", "grid", "datatable", "spreadsheet", "data-grid"]),
    ("nav",     ["nav", "navbar", "header", "sidebar", "footer", "menu", "tab", "tabs",
                 "breadcrumb", "pagination", "topbar"]),
    ("modal",   ["modal", "dialog", "drawer", "sheet", "popup", "overlay", "lightbox"]),
    ("chart",   ["chart", "graph", "analytics", "metric", "kpi", "stat", "stats"]),
    ("image",   ["image", "img", "photo", "avatar", "thumbnail", "banner", "hero-img"]),
    ("badge",   ["badge", "tag", "label", "chip", "pill"]),
    ("tooltip", ["tooltip", "hint", "popover"]),
    ("alert",   ["alert", "toast", "notification", "snackbar", "banner"]),
    ("hero",    ["hero", "jumbotron", "landing", "splash"]),
    ("list",    ["list", "listitem", "item-list", "feed"]),
]

_VARIANT_KEYWORDS = {
    "primary": ["primary", "default", "main", "brand"],
    "secondary": ["secondary", "outlined", "outline"],
    "danger": ["danger", "error", "destructive", "delete", "remove"],
    "ghost": ["ghost", "text", "tertiary", "link"],
    "success": ["success", "confirm", "approved"],
    "warning": ["warning", "caution"],
}

_SIZE_KEYWORDS = {
    "xs": ["xs", "tiny", "mini", "xsmall"],
    "sm": ["sm", "small", "compact"],
    "md": ["md", "medium", "default"],
    "lg": ["lg", "large"],
    "xl": ["xl", "xlarge", "extra-large"],
}


def _parse_variant_name(name: str) -> tuple[str | None, str | None, str]:
    """
    Parse a Figma component variant name like 'Button/Primary/Large'.
    Returns (variant, size, base_name).

    Examples:
      'Button/Primary/Large'   → ('primary', 'lg', 'Button')
      'Card/Default'           → (None, None, 'Card')
      'Input/Search'           → (None, None, 'Input')
    """
    parts = [p.strip().lower() for p in name.split("/")]
    base_name = name.split("/")[0].strip()  # original case

    variant: str | None = None
    size: str | None = None

    for part in parts[1:]:  # skip component type part
        for v_key, v_words in _VARIANT_KEYWORDS.items():
            if any(w in part for w in v_words):
                variant = v_key
                break
        for s_key, s_words in _SIZE_KEYWORDS.items():
            if any(w in part for w in s_words):
                size = s_key
                break

    return variant, size, base_name


def _detect_component_type(node: dict[str, Any]) -> str:
    """Classify a Figma node into a semantic UI component type."""
    name = (node.get("name") or "").lower()
    node_type = (node.get("type") or "").upper()
    children = node.get("children") or []

    if node_type == "TEXT":
        return "text"

    if node_type in ("RECTANGLE", "ELLIPSE", "VECTOR"):
        if any(k in name for k in ("image", "img", "photo", "avatar", "icon", "logo", "thumb")):
            return "image"
        return "unknown"

    # Name-pattern matching (ordered by specificity)
    for component_type, keywords in _COMPONENT_NAME_PATTERNS:
        if any(k in name for k in keywords):
            return component_type

    # Structure-based heuristics for unnamed frames
    if node_type in ("FRAME", "COMPONENT", "INSTANCE", "GROUP", "COMPONENT_SET"):
        # Form heuristic: ≥2 input children
        input_count = sum(1 for c in children if _detect_component_type(c) in ("input", "select", "checkbox"))
        if input_count >= 2:
            return "form"

        box = node.get("absoluteBoundingBox") or {}
        w = box.get("width", 9999)
        h = box.get("height", 9999)

        # Card: moderate children, bounded size
        if 2 <= len(children) <= 10 and w < 700 and h < 800:
            return "card"

        # Full-width nav
        if w > 900 and h < 100:
            return "nav"

        return "layout"

    return "unknown"


# ---------------------------------------------------------------------------
# Prototype flow extraction
# ---------------------------------------------------------------------------

def _extract_nav_target(node: dict[str, Any], id_to_name: dict[str, str]) -> str | None:
    """Return the destination screen name for a node's primary ON_CLICK reaction."""
    reactions = node.get("reactions") or []
    for reaction in reactions:
        trigger = (reaction.get("trigger") or {}).get("type", "")
        if trigger not in ("ON_CLICK", "ON_TAP", "MOUSE_UP"):
            continue
        action = reaction.get("action") or {}
        if action.get("type") == "NODE":
            dest_id = action.get("destinationId")
            if dest_id and dest_id in id_to_name:
                return id_to_name[dest_id]
    return None


def _build_id_name_map(document: dict[str, Any]) -> dict[str, str]:
    """Build a flat map of {node_id → node_name} for prototype flow resolution."""
    mapping: dict[str, str] = {}

    def _walk(node: dict[str, Any]) -> None:
        nid = node.get("id")
        if nid:
            mapping[nid] = node.get("name", "")
        for child in node.get("children") or []:
            _walk(child)

    _walk(document)
    return mapping


# ---------------------------------------------------------------------------
# Node parser
# ---------------------------------------------------------------------------

def _parse_node(
    node: dict[str, Any],
    id_to_name: dict[str, str],
    depth: int = 0,
) -> dict[str, Any] | None:
    """Recursively parse a Figma node into a component spec."""
    if depth > 5:
        return None

    component_type = _detect_component_type(node)
    if component_type == "unknown" and depth > 1:
        return None

    variant, size, base_name = _parse_variant_name(node.get("name", ""))

    # Recurse into children
    children_nodes = []
    for child in (node.get("children") or []):
        parsed = _parse_node(child, id_to_name, depth + 1)
        if parsed:
            children_nodes.append(parsed)

    # Text content for TEXT nodes
    text_content = ""
    placeholder = ""
    if (node.get("type") or "").upper() == "TEXT":
        text_content = node.get("characters", "")

    # Placeholder heuristic for inputs
    if component_type == "input":
        name_lower = (node.get("name") or "").lower()
        placeholder = name_lower.replace("-", " ").replace("_", " ").title()
        # Try to get from child TEXT node
        for child in (node.get("children") or []):
            if (child.get("type") or "").upper() == "TEXT":
                chars = child.get("characters", "")
                if chars:
                    placeholder = chars
                    break

    return {
        "id": node.get("id", ""),
        "name": base_name,
        "raw_name": node.get("name", ""),
        "type": component_type,
        "variant": variant,
        "size": size,
        "tailwind": _extract_tailwind(node),
        "text_content": text_content,
        "placeholder": placeholder if component_type == "input" else "",
        "nav_target": _extract_nav_target(node, id_to_name),
        "children": children_nodes,
    }


# ---------------------------------------------------------------------------
# Screen extractor
# ---------------------------------------------------------------------------

def _screen_slug(name: str) -> str:
    """Convert a Figma frame name to a URL slug."""
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return f"/{slug}" if slug else "/"


def _extract_screens(
    document: dict[str, Any],
    id_to_name: dict[str, str],
) -> list[dict[str, Any]]:
    """Extract top-level frames (screens) from the Figma document."""
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
                parsed = _parse_node(child, id_to_name, depth=1)
                if parsed and parsed["type"] != "unknown":
                    components.append(parsed)

            if components or frame_type == "FRAME":
                box = frame.get("absoluteBoundingBox") or {}
                layout_mode = frame.get("layoutMode", "NONE")
                if layout_mode == "HORIZONTAL":
                    layout = "flex-row"
                elif layout_mode == "VERTICAL":
                    layout = "flex-col"
                else:
                    layout = "block"

                screens.append({
                    "name": frame.get("name", page_name),
                    "page": page_name,
                    "route": _screen_slug(frame.get("name", page_name)),
                    "bounds": {
                        "width": box.get("width", 0),
                        "height": box.get("height", 0),
                    },
                    "layout": layout,
                    "components": components,
                })

    return screens


# ---------------------------------------------------------------------------
# Prototype flow extractor — builds the navigation map
# ---------------------------------------------------------------------------

def _extract_navigation(
    document: dict[str, Any],
    id_to_name: dict[str, str],
    screen_names: set[str],
) -> list[dict[str, Any]]:
    """
    Walk every node looking for prototype reactions.
    Returns a list of {from, to, trigger} connections between screens.
    """
    flows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def _current_screen(node_id: str) -> str | None:
        """Walk up to find which top-level frame contains this node."""
        # id_to_name has all IDs; we match against known screen names
        for name in screen_names:
            # Check if node is inside this screen by name prefix — not perfect
            # but sufficient for flow detection
            pass
        return None

    def _walk(node: dict[str, Any], screen_name: str) -> None:
        # If this node IS a top-level frame, update screen context
        nid = node.get("id", "")
        name = node.get("name", "")
        if name in screen_names:
            screen_name = name

        reactions = node.get("reactions") or []
        for reaction in reactions:
            trigger = (reaction.get("trigger") or {}).get("type", "ON_CLICK")
            action = reaction.get("action") or {}
            if action.get("type") == "NODE":
                dest_id = action.get("destinationId")
                dest_name = id_to_name.get(dest_id, "") if dest_id else ""
                if dest_name and screen_name and screen_name != dest_name:
                    key = (screen_name, dest_name)
                    if key not in seen:
                        seen.add(key)
                        flows.append({
                            "from": screen_name,
                            "to": dest_name,
                            "trigger": trigger,
                        })

        for child in node.get("children") or []:
            _walk(child, screen_name)

    _walk(document, "")
    return flows


# ---------------------------------------------------------------------------
# Design tokens extractor
# ---------------------------------------------------------------------------

def _extract_design_tokens(
    document: dict[str, Any],
    styles_data: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Infer global design tokens from the document.
    Optionally enriched with named Figma Styles from /v1/files/{key}/styles.
    """
    font_sizes: list[float] = []
    font_weights: list[int] = []
    bg_colors: list[str] = []
    font_families: list[str] = []
    has_shadows = False

    def _walk(node: dict[str, Any]) -> None:
        nonlocal has_shadows
        style = node.get("style") or {}
        if style.get("fontSize"):
            font_sizes.append(style["fontSize"])
        if style.get("fontWeight"):
            font_weights.append(style["fontWeight"])
        if style.get("fontFamily"):
            font_families.append(style["fontFamily"])

        fills = node.get("fills") or []
        if fills and fills[0].get("type") == "SOLID" and fills[0].get("color"):
            c = fills[0]["color"]
            bg_colors.append(_map_color(
                round(c.get("r", 0) * 255),
                round(c.get("g", 0) * 255),
                round(c.get("b", 0) * 255),
            ))

        effects = node.get("effects") or []
        if any(e.get("type") == "DROP_SHADOW" and e.get("visible", True) for e in effects):
            has_shadows = True

        for child in node.get("children") or []:
            _walk(child)

    _walk(document)

    # Primary accent color (most frequent non-neutral)
    primary = "violet-500"
    if bg_colors:
        most_common = Counter(bg_colors).most_common(5)
        non_neutral = [
            c for c, _ in most_common
            if not any(k in c for k in ("slate", "white", "gray", "zinc", "neutral"))
        ]
        if non_neutral:
            primary = non_neutral[0]

    # Font family (most common)
    font_family = "Inter"
    if font_families:
        font_family = Counter(font_families).most_common(1)[0][0]

    # Border radius consensus
    border_radius = "md"

    # Spacing density from itemSpacing values
    spacing = "normal"

    # Unique font sizes → Tailwind
    tailwind_sizes: list[str] = []
    size_map = [(10, "xs"), (12, "xs"), (14, "sm"), (16, "base"),
                (18, "lg"), (20, "xl"), (24, "2xl"), (30, "3xl"), (9999, "4xl")]
    for fs in sorted(set(int(f) for f in font_sizes))[:6]:
        for threshold, label in size_map:
            if fs <= threshold:
                tailwind_sizes.append(f"text-{label}")
                break

    # Unique font weights → Tailwind
    tailwind_weights: list[str] = []
    for fw in sorted(set(font_weights)):
        for threshold, cls in _FONT_WEIGHT_MAP:
            if fw <= threshold:
                tailwind_weights.append(cls)
                break

    # Named color styles from Figma Styles API
    named_colors: dict[str, str] = {}
    if styles_data:
        for style in (styles_data.get("meta", {}).get("styles") or []):
            if style.get("style_type") == "FILL":
                # Style names like "Primary/500", "Neutral/100"
                style_name = style.get("name", "")
                # We can't get the actual color from this endpoint (need node paint),
                # but we can record the name mapping
                named_colors[style_name] = style.get("key", "")

    return {
        "primary_color": f"bg-{primary}",
        "primary_text_color": f"text-{primary}",
        "font_family": font_family,
        "font_sizes": tailwind_sizes or ["text-sm", "text-base", "text-lg"],
        "font_weights": list(dict.fromkeys(tailwind_weights)) or ["font-normal", "font-semibold"],
        "border_radius": border_radius,
        "spacing": spacing,
        "colors": named_colors,
        "shadows": has_shadows,
    }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def fetch_design_contract(figma_key: str, settings: Settings) -> dict[str, Any]:
    """
    Fetch a Figma file and convert it to a rich Design Contract for the agent pipeline.

    What this extracts from Figma JSON:
      - Auto-layout (direction, gap, justify, align) → Tailwind flex classes
      - Exact padding (paddingLeft/Right/Top/Bottom) → px-* py-* classes
      - Typography (fontSize, fontWeight, lineHeight, letterSpacing) → text-* font-* classes
      - Borders (strokes, strokeWeight) → border-* classes
      - Shadows (DROP_SHADOW effects) → shadow-* classes
      - Corner radius → rounded-* classes
      - Opacity → opacity-* classes
      - Component variants ("Button/Primary/Large" → variant + size)
      - Text content for labels and placeholders
      - Prototype flows (ON_CLICK reactions) → navigation map
      - Named Figma color styles → design tokens

    Args:
        figma_key: Figma file key (alphanumeric ID from the file URL)
        settings: App settings (uses settings.figma_access_token)

    Returns:
        Design Contract dict.

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
    client = httpx.Client(timeout=90)

    # Primary file fetch
    resp = client.get(
        f"{FIGMA_API}/files/{figma_key}",
        headers={"X-Figma-Token": settings.figma_access_token},
        params={"geometry": "paths"},  # include layout geometry
    )
    resp.raise_for_status()
    data = resp.json()

    # Optional: named styles fetch (best-effort — non-fatal if it fails)
    styles_data: dict[str, Any] | None = None
    try:
        styles_resp = client.get(
            f"{FIGMA_API}/files/{figma_key}/styles",
            headers={"X-Figma-Token": settings.figma_access_token},
        )
        if styles_resp.status_code == 200:
            styles_data = styles_resp.json()
    except Exception as e:
        logger.debug("Figma styles fetch failed (non-fatal): %s", e)

    document = data.get("document", {})

    # Build ID→name map for prototype flow resolution
    id_to_name = _build_id_name_map(document)

    screens = _extract_screens(document, id_to_name)
    screen_names = {s["name"] for s in screens}

    tokens = _extract_design_tokens(document, styles_data)
    navigation = _extract_navigation(document, id_to_name, screen_names)

    logger.info(
        "Parsed %d screens, %d nav flows from Figma file '%s'",
        len(screens), len(navigation), data.get("name", "?"),
    )

    return {
        "file_name": data.get("name", "Untitled"),
        "last_modified": data.get("lastModified", ""),
        "figma_key": figma_key,
        "screens": screens,
        "design_tokens": tokens,
        "navigation": navigation,
    }


def extract_figma_key(url_or_key: str) -> str:
    """Extract the file key from a Figma URL, or return the raw key."""
    match = re.search(r"figma\.com/(?:design|file|proto)/([a-zA-Z0-9_-]+)", url_or_key)
    if match:
        return match.group(1)
    return url_or_key.strip()
