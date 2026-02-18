import type { FigmaNode, FigmaComponent } from "@/types";

// ---------------------------------------------------------------------------
// Figma Client — Thin wrapper for /api/figma/sync proxy
// Token stays server-side. All calls go through our Next.js API route.
// ---------------------------------------------------------------------------

export class FigmaClientError extends Error {
  status: number;
  constructor(message: string, status: number = 500) {
    super(message);
    this.name = "FigmaClientError";
    this.status = status;
  }
}

/** Validate a Figma file key format (alphanumeric, 10+ chars) */
export function validateFileKey(key: string): boolean {
  return /^[a-zA-Z0-9_-]{10,}$/.test(key);
}

/** Extract file key from a Figma URL or return the raw key */
export function extractFileKey(input: string): string {
  const trimmed = input.trim();
  // Match Figma URLs: figma.com/design/KEY/... or figma.com/file/KEY/...
  const urlMatch = trimmed.match(
    /figma\.com\/(?:design|file|proto)\/([a-zA-Z0-9_-]+)/,
  );
  if (urlMatch) return urlMatch[1];
  // Otherwise treat as raw key
  return trimmed;
}

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/figma/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new FigmaClientError(
      data.error || `Request failed (${res.status})`,
      res.status,
    );
  }
  return data as T;
}

/** Sync a Figma file — returns sanitized document tree */
export async function syncFigmaFile(
  fileKey: string,
): Promise<{ name: string; lastModified: string; document: FigmaNode }> {
  if (!validateFileKey(fileKey)) {
    throw new FigmaClientError("Invalid Figma file key", 400);
  }
  return post({ fileKey, action: "sync" });
}

/** Fetch component list from a Figma file */
export async function fetchFigmaComponents(
  fileKey: string,
): Promise<{ components: FigmaComponent[] }> {
  if (!validateFileKey(fileKey)) {
    throw new FigmaClientError("Invalid Figma file key", 400);
  }
  return post({ fileKey, action: "components" });
}

/** Fetch rendered images for specific node IDs */
export async function fetchFigmaImages(
  fileKey: string,
  nodeIds: string[],
): Promise<{ images: Record<string, string> }> {
  if (!validateFileKey(fileKey)) {
    throw new FigmaClientError("Invalid Figma file key", 400);
  }
  if (nodeIds.length === 0) {
    throw new FigmaClientError("At least one node ID required", 400);
  }
  return post({ fileKey, action: "images", nodeIds });
}
