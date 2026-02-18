import type {
  FigmaNode,
  FigmaComponentType,
  FigmaComponentMapping,
} from "@/types";

// ---------------------------------------------------------------------------
// Figma Mapper — Converts Figma node tree into component mappings.
// Uses heuristic detection + existing Tailwind tokens. No config changes.
// ---------------------------------------------------------------------------

/** Detect the UI component type from a Figma node */
export function detectComponentType(node: FigmaNode): FigmaComponentType {
  const name = (node.name || "").toLowerCase();
  const type = (node.type || "").toUpperCase();

  // Text nodes
  if (type === "TEXT") return "text";

  // Image-like nodes
  if (type === "RECTANGLE" || type === "ELLIPSE" || type === "VECTOR") {
    if (name.match(/image|img|photo|avatar|icon|logo/)) return "image";
  }

  // Name-based heuristics (most reliable)
  if (name.match(/button|btn|cta|submit|action/)) return "button";
  if (name.match(/input|field|text-?input|search-?bar|text-?field/)) return "input";
  if (name.match(/form|sign-?up|login|register|checkout/)) return "form";
  if (name.match(/card|tile|item|product|feature/)) return "card";
  if (name.match(/table|grid|list|data-?table|spreadsheet/)) return "table";
  if (name.match(/nav|header|sidebar|footer|menu|tab-?bar|breadcrumb/)) return "nav";

  // Structure-based heuristics for frames
  if (type === "FRAME" || type === "COMPONENT" || type === "INSTANCE" || type === "GROUP") {
    const childCount = node.children?.length ?? 0;

    // Check if children suggest a form (multiple input-like children)
    if (childCount >= 2) {
      const inputChildren = (node.children || []).filter(
        (c) => detectComponentType(c) === "input",
      ).length;
      if (inputChildren >= 2) return "form";
    }

    // Card: moderate children with bounded size
    if (childCount >= 2 && childCount <= 6) {
      const box = node.boundingBox;
      if (box && box.width < 500 && box.height < 600) return "card";
    }

    return "layout";
  }

  return "unknown";
}

/** Map Figma fill colors to existing Tailwind brand/surface tokens */
function mapColorToToken(r: number, g: number, b: number): string {
  // Brand purple: #8b5cf6 (139, 92, 246)
  if (Math.abs(r - 139) < 30 && Math.abs(g - 92) < 30 && Math.abs(b - 246) < 30) {
    return "bg-brand-500";
  }
  // Dark surfaces
  if (r < 40 && g < 40 && b < 50) return "bg-surface-0";
  if (r < 60 && g < 60 && b < 70) return "bg-surface-1";
  if (r < 80 && g < 80 && b < 90) return "bg-surface-2";
  // Light/white
  if (r > 240 && g > 240 && b > 240) return "bg-white";
  if (r > 220 && g > 220 && b > 220) return "bg-slate-100";
  // Grays
  if (Math.abs(r - g) < 15 && Math.abs(g - b) < 15) {
    if (r > 180) return "bg-slate-200";
    if (r > 120) return "bg-slate-400";
    return "bg-slate-600";
  }
  // Emerald/success
  if (g > r + 50 && g > b + 20) return "bg-emerald-500";
  // Red/error
  if (r > g + 50 && r > b + 50) return "bg-red-500";
  // Amber/warning
  if (r > 200 && g > 150 && b < 100) return "bg-amber-500";

  return "bg-surface-2";
}

/** Map Figma font size to Tailwind text-* class */
function mapFontSize(size: number): string {
  if (size <= 10) return "text-2xs";
  if (size <= 12) return "text-xs";
  if (size <= 14) return "text-sm";
  if (size <= 16) return "text-base";
  if (size <= 18) return "text-lg";
  if (size <= 20) return "text-xl";
  if (size <= 24) return "text-2xl";
  if (size <= 30) return "text-3xl";
  return "text-4xl";
}

/** Map Figma border radius to Tailwind rounded-* class */
function mapBorderRadius(radius: number): string {
  if (radius <= 0) return "";
  if (radius <= 2) return "rounded-sm";
  if (radius <= 4) return "rounded";
  if (radius <= 6) return "rounded-md";
  if (radius <= 8) return "rounded-lg";
  if (radius <= 12) return "rounded-xl";
  if (radius <= 16) return "rounded-2xl";
  return "rounded-full";
}

/** Map Figma padding to Tailwind p-* class */
function mapPadding(padding: number): string {
  if (padding <= 0) return "";
  if (padding <= 4) return "p-1";
  if (padding <= 8) return "p-2";
  if (padding <= 12) return "p-3";
  if (padding <= 16) return "p-4";
  if (padding <= 24) return "p-6";
  if (padding <= 32) return "p-8";
  return "p-10";
}

/** Generate Tailwind classes from Figma style properties */
export function generateTailwindFromStyles(
  styles: Record<string, unknown>,
): string {
  const classes: string[] = [];

  // Background color
  const fills = styles.fills as Array<{ color?: { r: number; g: number; b: number } }> | undefined;
  if (fills && fills.length > 0 && fills[0].color) {
    const c = fills[0].color;
    classes.push(mapColorToToken(Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)));
  }

  // Font size
  const textStyle = styles as Record<string, unknown>;
  const fontSize = textStyle.fontSize as number | undefined;
  if (fontSize) classes.push(mapFontSize(fontSize));

  // Border radius
  const cornerRadius = textStyle.cornerRadius as number | undefined;
  if (cornerRadius) {
    const rc = mapBorderRadius(cornerRadius);
    if (rc) classes.push(rc);
  }

  // Padding
  const paddingLeft = textStyle.paddingLeft as number | undefined;
  if (paddingLeft) {
    const pc = mapPadding(paddingLeft);
    if (pc) classes.push(pc);
  }

  // Shadow
  const effects = styles.effects as Array<{ type: string }> | undefined;
  if (effects?.some((e) => e.type === "DROP_SHADOW")) {
    classes.push("shadow-md");
  }

  return classes.join(" ");
}

/** Simple hash for change detection */
export function hashComponent(mapping: FigmaComponentMapping): string {
  const str = `${mapping.figmaId}:${mapping.componentType}:${mapping.tailwindClasses}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(Math.abs(hash));
}

/** Recursively walk a Figma node tree and produce component mappings */
export function mapFigmaToComponents(
  nodeTree: FigmaNode,
  depth: number = 0,
): FigmaComponentMapping[] {
  const mappings: FigmaComponentMapping[] = [];

  // Only map top-level meaningful frames (depth 1-2), not every nested element
  if (depth > 0 && depth <= 3) {
    const componentType = detectComponentType(nodeTree);
    if (componentType !== "unknown") {
      const tailwindClasses = nodeTree.styles
        ? generateTailwindFromStyles(nodeTree.styles)
        : "";

      const mapping: FigmaComponentMapping = {
        figmaId: nodeTree.id,
        figmaName: nodeTree.name,
        componentType,
        tailwindClasses,
        props: {},
        confidence: componentType === "layout" ? 0.5 : 0.8,
        action: "create",
      };
      mappings.push(mapping);
    }
  }

  // Recurse into children
  if (nodeTree.children && depth < 3) {
    for (const child of nodeTree.children) {
      mappings.push(...mapFigmaToComponents(child, depth + 1));
    }
  }

  return mappings;
}

/** Diff existing vs incoming mappings using hash comparison */
export function diffMappings(
  existing: FigmaComponentMapping[],
  incoming: FigmaComponentMapping[],
): {
  added: FigmaComponentMapping[];
  changed: FigmaComponentMapping[];
  unchanged: FigmaComponentMapping[];
} {
  const existingMap = new Map(
    existing.map((m) => [m.figmaId, { mapping: m, hash: hashComponent(m) }]),
  );

  const added: FigmaComponentMapping[] = [];
  const changed: FigmaComponentMapping[] = [];
  const unchanged: FigmaComponentMapping[] = [];

  for (const m of incoming) {
    const prev = existingMap.get(m.figmaId);
    if (!prev) {
      added.push(m);
    } else if (prev.hash !== hashComponent(m)) {
      changed.push(m);
    } else {
      unchanged.push(m);
    }
  }

  return { added, changed, unchanged };
}
