"""
SEARCH/REPLACE to Unified Diff converter.

Parses the ===EDIT: path=== / <<<SEARCH / >>>REPLACE / ===END_EDIT===
format that agents sometimes output and converts to unified diff patches
that git apply can handle.
"""

from __future__ import annotations

import difflib
import re
from typing import Any

_BLOCK_PATTERN = re.compile(
    r'===EDIT:\s*(.+?)\s*===\s*\n'
    r'<<<SEARCH\n(.*?)\n>>>REPLACE\n(.*?)\n===END_EDIT===',
    re.DOTALL,
)


def parse_search_replace_blocks(content: str) -> list[dict[str, Any]]:
    """Parse SEARCH/REPLACE format into structured blocks."""
    blocks = []
    for match in _BLOCK_PATTERN.finditer(content):
        blocks.append({
            "file": match.group(1).strip(),
            "search": match.group(2),
            "replace": match.group(3),
        })
    return blocks


def _fuzzy_find(original: str, search_text: str) -> int:
    """Try to find search_text in original with whitespace normalization."""
    # Exact match first
    idx = original.find(search_text)
    if idx >= 0:
        return idx

    # Normalize whitespace and try again
    norm_original = re.sub(r'[ \t]+', ' ', original)
    norm_search = re.sub(r'[ \t]+', ' ', search_text)
    idx = norm_original.find(norm_search)
    if idx >= 0:
        # Map back to original position (approximate)
        return original.find(original.split('\n')[norm_original[:idx].count('\n')])

    return -1


def search_replace_to_diff(
    blocks: list[dict[str, Any]],
    existing_files: dict[str, str],
) -> list[str]:
    """Convert SEARCH/REPLACE blocks to unified diff patches."""
    patches = []
    for block in blocks:
        file_path = block["file"]
        search_text = block["search"]
        replace_text = block["replace"]

        original = existing_files.get(file_path, "")
        if not original:
            # New file — generate a creation diff
            if replace_text.strip():
                new_lines = replace_text.splitlines(keepends=True)
                if new_lines and not new_lines[-1].endswith('\n'):
                    new_lines[-1] += '\n'
                diff = difflib.unified_diff(
                    [], new_lines,
                    fromfile=f"a/{file_path}",
                    tofile=f"b/{file_path}",
                )
                patch = "".join(diff)
                if patch:
                    patches.append(patch)
            continue

        # Find the search text
        idx = _fuzzy_find(original, search_text)
        if idx == -1:
            continue

        # Build the replacement
        new_content = original[:idx] + replace_text + original[idx + len(search_text):]

        original_lines = original.splitlines(keepends=True)
        new_lines = new_content.splitlines(keepends=True)

        diff = difflib.unified_diff(
            original_lines, new_lines,
            fromfile=f"a/{file_path}",
            tofile=f"b/{file_path}",
        )
        patch = "".join(diff)
        if patch:
            patches.append(patch)

    return patches
