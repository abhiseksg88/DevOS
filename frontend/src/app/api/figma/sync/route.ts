import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// POST /api/figma/sync — Proxy for Figma REST API
// Keeps FIGMA_ACCESS_TOKEN server-side. Returns sanitized design JSON.
// ---------------------------------------------------------------------------

// Rate limiter: 20 requests per minute per IP (same pattern as /api/generate)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 20;
const RATE_WINDOW = 60_000;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

const FIGMA_API = "https://api.figma.com/v1";
const FILE_KEY_RE = /^[a-zA-Z0-9_-]{10,}$/;

type SyncAction = "sync" | "components" | "images";

interface SyncBody {
  fileKey: string;
  action: SyncAction;
  nodeIds?: string[];
}

// Sanitize Figma node tree — strip personal info, keep only design data
function sanitizeNode(node: Record<string, unknown>): Record<string, unknown> {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    ...(node.absoluteBoundingBox ? { boundingBox: node.absoluteBoundingBox } : {}),
    ...(node.fills ? { styles: { fills: node.fills, strokes: node.strokes, effects: node.effects } } : {}),
    ...(node.style ? { textStyle: node.style } : {}),
    ...(node.children
      ? { children: (node.children as Record<string, unknown>[]).map(sanitizeNode) }
      : {}),
  };
}

export async function POST(req: NextRequest) {
  // Rate limit
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!checkRateLimit(ip)) {
    return NextResponse.json(
      { error: "Rate limit exceeded. Try again in a minute." },
      { status: 429 },
    );
  }

  // Check token
  const token = process.env.FIGMA_ACCESS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "FIGMA_ACCESS_TOKEN is not configured. Add it to your .env.local file." },
      { status: 503 },
    );
  }

  // Parse body
  let body: SyncBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { fileKey, action, nodeIds } = body;

  // Validate
  if (!fileKey || !FILE_KEY_RE.test(fileKey)) {
    return NextResponse.json(
      { error: "Invalid Figma file key. It should be the alphanumeric ID from the Figma URL." },
      { status: 400 },
    );
  }
  if (!action || !["sync", "components", "images"].includes(action)) {
    return NextResponse.json(
      { error: "Invalid action. Must be: sync, components, or images." },
      { status: 400 },
    );
  }

  const headers = { "X-Figma-Token": token };

  try {
    if (action === "sync") {
      const res = await fetch(`${FIGMA_API}/files/${fileKey}`, { headers });
      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json(
          { error: `Figma API error: ${res.status} — ${text.slice(0, 200)}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      return NextResponse.json({
        name: data.name,
        lastModified: data.lastModified,
        document: sanitizeNode(data.document),
      });
    }

    if (action === "components") {
      const res = await fetch(`${FIGMA_API}/files/${fileKey}/components`, { headers });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Figma API error: ${res.status}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      const components = (data.meta?.components || []).map(
        (c: Record<string, unknown>) => ({
          id: c.node_id || c.key,
          name: c.name,
          type: c.containing_frame ? "COMPONENT" : "INSTANCE",
          description: c.description || "",
          thumbnailUrl: c.thumbnail_url || null,
        }),
      );
      return NextResponse.json({ components });
    }

    if (action === "images") {
      if (!nodeIds || nodeIds.length === 0) {
        return NextResponse.json({ error: "nodeIds required for images action" }, { status: 400 });
      }
      const ids = nodeIds.slice(0, 20).join(","); // Max 20 nodes
      const res = await fetch(
        `${FIGMA_API}/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=png&scale=2`,
        { headers },
      );
      if (!res.ok) {
        return NextResponse.json(
          { error: `Figma API error: ${res.status}` },
          { status: res.status },
        );
      }
      const data = await res.json();
      return NextResponse.json({ images: data.images || {} });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach Figma API: ${(err as Error).message}` },
      { status: 502 },
    );
  }
}
