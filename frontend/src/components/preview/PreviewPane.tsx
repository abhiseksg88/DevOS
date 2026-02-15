"use client";

import { useState, useMemo } from "react";
import {
  RefreshCw,
  ExternalLink,
  Smartphone,
  Tablet,
  Monitor,
  Globe,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/types";

type ViewportSize = "mobile" | "tablet" | "desktop";

const VIEWPORTS: Record<ViewportSize, { width: string; icon: typeof Monitor; label: string }> = {
  mobile: { width: "375px", icon: Smartphone, label: "Mobile" },
  tablet: { width: "768px", icon: Tablet, label: "Tablet" },
  desktop: { width: "100%", icon: Monitor, label: "Desktop" },
};

interface PreviewPaneProps {
  url: string | null;
  files?: FileNode[];
}

/** Recursively collect all file nodes from a tree */
function flattenFiles(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.type === "file") {
      result.push(node);
    }
    if (node.children) {
      result.push(...flattenFiles(node.children));
    }
  }
  return result;
}

/** Find CSS content from file tree */
function collectCSS(files: FileNode[]): string {
  return files
    .filter((f) => f.path.endsWith(".css") && f.content)
    .map((f) => f.content!)
    .join("\n");
}

/** Extract the main page/component JSX content */
function extractMainContent(files: FileNode[]): string {
  const mainFile =
    files.find((f) => f.path.includes("page.tsx") || f.path.includes("page.jsx")) ??
    files.find((f) => f.path.includes("App.tsx") || f.path.includes("App.jsx")) ??
    files.find((f) => f.path.includes("index.tsx") || f.path.includes("index.jsx")) ??
    files.find((f) => (f.language === "typescriptreact" || f.language === "javascriptreact") && f.content);

  if (!mainFile?.content) return "";
  return mainFile.content;
}

/** Convert JSX-like code to renderable HTML preview */
function jsxToPreviewHTML(jsxContent: string): string {
  const returnMatch = jsxContent.match(/return\s*\(\s*([\s\S]*?)\s*\);\s*\}?/);
  let jsx = returnMatch ? returnMatch[1] : "";

  if (!jsx) {
    const jsxBlockMatch = jsxContent.match(/<[a-zA-Z][\s\S]*>/);
    jsx = jsxBlockMatch ? jsxBlockMatch[0] : "";
  }

  if (!jsx) return "";

  let html = jsx
    .replace(/className=/g, "class=")
    .replace(/=\{`([^`]*)`\}/g, '="$1"')
    .replace(/\{"([^"]*)"\}/g, "$1")
    .replace(/\{([a-zA-Z_]\w*)\}/g, "$1")
    .replace(/<(\w+)([^>]*)\s\/>/g, "<$1$2></$1>")
    .replace(/\s(on[A-Z]\w*)=\{[^}]*\}/g, "")
    .replace(/\s\{\.\.\.[\w]+\}/g, "")
    .replace(/htmlFor=/g, "for=");

  return html;
}

/** Build a full preview HTML document from file content */
function buildPreviewDocument(files: FileNode[]): string {
  const allFiles = flattenFiles(files);
  const css = collectCSS(allFiles);
  const mainContent = extractMainContent(allFiles);
  const previewHTML = jsxToPreviewHTML(mainContent);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.tailwindcss.com"><\/script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    ${css.replace(/@tailwind\s+\w+;/g, "")}
  </style>
</head>
<body>
  ${previewHTML || `
  <div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fafafa;color:#888;font-family:system-ui;">
    <div style="text-align:center;">
      <p style="font-size:14px;">Send a prompt to generate your app preview</p>
    </div>
  </div>`}
</body>
</html>`;
}

export function PreviewPane({ url, files }: PreviewPaneProps) {
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);

  const srcdoc = useMemo(() => {
    if (files && files.length > 0) {
      return buildPreviewDocument(files);
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, refreshKey]);

  const hasUrl = !!url;
  const hasLivePreview = !!srcdoc;
  const hasAnyPreview = hasUrl || hasLivePreview;

  if (!hasAnyPreview) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-surface-0">
        <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-surface-3 flex items-center justify-center mb-5">
          <Globe className="w-8 h-8 text-slate-600" />
        </div>
        <h3 className="text-white font-medium mb-2">No Preview Available</h3>
        <p className="text-slate-500 text-sm text-center max-w-xs leading-relaxed">
          Send a prompt to the AI agent to generate your app. Once built,
          a live preview will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Toolbar */}
      <div className="h-10 border-b border-surface-3 flex items-center justify-between px-3 shrink-0">
        <div className="flex items-center gap-1">
          {(Object.entries(VIEWPORTS) as [ViewportSize, typeof VIEWPORTS[ViewportSize]][]).map(
            ([key, { icon: Icon, label }]) => (
              <button
                key={key}
                onClick={() => setViewport(key)}
                title={label}
                className={cn(
                  "p-1.5 rounded-md transition-all",
                  viewport === key
                    ? "bg-surface-3 text-white"
                    : "text-slate-600 hover:text-slate-300 hover:bg-surface-2"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
              </button>
            )
          )}

          {/* Live preview badge */}
          {!hasUrl && hasLivePreview && (
            <div className="flex items-center gap-1 ml-2 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
              <Play className="w-2.5 h-2.5 text-emerald-400 fill-emerald-400" />
              <span className="text-2xs text-emerald-400 font-medium">Live</span>
            </div>
          )}
        </div>

        {/* URL bar */}
        <div className="flex-1 mx-3 px-3 py-1 rounded-md bg-surface-2 border border-surface-3 text-xs text-slate-500 truncate font-mono">
          {hasUrl ? url : "live-preview://localhost"}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {hasUrl && (
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
              title="Open in new tab"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          )}
        </div>
      </div>

      {/* iframe */}
      <div className="flex-1 flex items-start justify-center p-4 bg-surface-2/30 overflow-auto">
        <div
          className="bg-white rounded-lg shadow-2xl overflow-hidden transition-all duration-300 h-full"
          style={{ width: VIEWPORTS[viewport].width, maxWidth: "100%" }}
        >
          {hasUrl ? (
            <iframe
              key={refreshKey}
              src={url}
              className="w-full h-full border-0"
              title="App Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          ) : (
            <iframe
              key={`live-${refreshKey}`}
              srcDoc={srcdoc!}
              className="w-full h-full border-0"
              title="Live Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          )}
        </div>
      </div>
    </div>
  );
}
