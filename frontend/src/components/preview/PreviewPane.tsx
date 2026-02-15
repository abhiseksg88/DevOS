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

/** Extract content between balanced open/close characters starting at startIdx */
function extractBalanced(code: string, startIdx: number, open: string, close: string): string {
  let depth = 0;
  for (let i = startIdx; i < code.length; i++) {
    // Skip string literals to avoid counting parens inside strings
    if (code[i] === '"' || code[i] === "'" || code[i] === "`") {
      const quote = code[i];
      i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (code[i] === open) depth++;
    else if (code[i] === close) {
      depth--;
      if (depth === 0) return code.slice(startIdx + 1, i).trim();
    }
  }
  return "";
}

/** Extract the JSX block from a React component's source code */
function extractJSXBlock(code: string): string {
  // Pattern 1: return (...) — function component with return statement
  const returnIdx = code.search(/return\s*\(/);
  if (returnIdx !== -1) {
    const openParen = code.indexOf("(", returnIdx);
    if (openParen !== -1) {
      const result = extractBalanced(code, openParen, "(", ")");
      if (result) return result;
    }
  }

  // Pattern 2: => (...) — arrow function with parenthesized body
  const arrowParenIdx = code.search(/=>\s*\(/);
  if (arrowParenIdx !== -1) {
    const openParen = code.indexOf("(", arrowParenIdx);
    if (openParen !== -1) {
      const result = extractBalanced(code, openParen, "(", ")");
      if (result) return result;
    }
  }

  // Pattern 3: => <tag — arrow function returning JSX directly (no parens)
  const arrowJsxMatch = code.match(/=>\s*(<[a-zA-Z][\s\S]*<\/[a-zA-Z][\w]*>)/);
  if (arrowJsxMatch) return arrowJsxMatch[1];

  // Pattern 4: Find the outermost JSX element
  const jsxStartMatch = code.match(/<([a-zA-Z][\w.]*)/);
  if (jsxStartMatch && jsxStartMatch.index !== undefined) {
    const tagName = jsxStartMatch[1];
    const startIdx = jsxStartMatch.index;
    const closingTag = `</${tagName}>`;
    const endIdx = code.lastIndexOf(closingTag);
    if (endIdx > startIdx) {
      return code.slice(startIdx, endIdx + closingTag.length);
    }
  }

  return "";
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

/** Find a component file and extract its JSX */
function getComponentJSX(componentName: string, allFiles: FileNode[]): string | null {
  const variations = [
    `${componentName}.tsx`,
    `${componentName}.jsx`,
    `${componentName}.ts`,
    `${componentName}.js`,
  ];
  const file = allFiles.find(
    (f) => f.type === "file" && variations.includes(f.name) && f.content
  );
  if (!file?.content) return null;
  return extractJSXBlock(file.content) || null;
}

/**
 * Inline sub-components: replace <Component /> and <Component>...</Component>
 * with the actual JSX from the component's source file.
 */
function inlineComponents(jsx: string, allFiles: FileNode[], depth = 0): string {
  if (depth > 5) return jsx; // prevent infinite recursion
  let result = jsx;

  // Replace self-closing component tags: <PascalCase ... />
  result = result.replace(
    /<([A-Z][a-zA-Z0-9]*)\b[^>]*?\/>/g,
    (_match, componentName) => {
      const componentJSX = getComponentJSX(componentName, allFiles);
      if (componentJSX) {
        return inlineComponents(componentJSX, allFiles, depth + 1);
      }
      return ""; // remove unknown component tags
    }
  );

  // Replace paired component tags: <Component>...</Component>
  result = result.replace(
    /<([A-Z][a-zA-Z0-9]*)\b[^>]*>([\s\S]*?)<\/\1>/g,
    (_match, componentName, _children) => {
      const componentJSX = getComponentJSX(componentName, allFiles);
      if (componentJSX) {
        return inlineComponents(componentJSX, allFiles, depth + 1);
      }
      return ""; // remove unknown component tags
    }
  );

  return result;
}

/** Convert JSX-like code to renderable HTML preview */
function convertJSXToHTML(jsx: string): string {
  if (!jsx) return "";

  let html = jsx
    // className → class
    .replace(/className=/g, "class=")
    // Template literal attributes: ={`...`} → ="..."
    .replace(/=\{`([^`]*)`\}/g, '="$1"')
    // String expressions: {"text"} → text
    .replace(/\{"([^"]*)"\}/g, "$1")
    // JSX comments: {/* ... */}
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    // Remove .map() calls (dynamic lists can't be statically rendered)
    .replace(/\{[\w.]+\.map\([\s\S]*?\)\)\}/g, "")
    // Remove ternary expressions
    .replace(/\{[^{}]*\?[^{}]*:[^{}]*\}/g, "")
    // Remove short-circuit rendering: {condition && <...>}
    .replace(/\{[\w.!]+\s*&&\s*[^}]*\}/g, "")
    // Simple variable references → show as text placeholder
    .replace(/\{([a-zA-Z_][\w.]*)\}/g, "$1")
    // Remove any remaining {...} expressions with nested braces
    .replace(/\{[^}]*\}/g, "")
    // Self-closing tags → explicit close
    .replace(/<(\w+)([^>]*?)\s*\/>/g, "<$1$2></$1>")
    // Remove event handlers: onClick={...}, onChange={...}, etc.
    .replace(/\s+on[A-Z]\w*=\{[^}]*\}/g, "")
    // Remove spread props: {...props}
    .replace(/\s+\{\.\.\.[\w]+\}/g, "")
    // htmlFor → for
    .replace(/htmlFor=/g, "for=")
    // Remove React-specific attributes
    .replace(/\s+key=\{[^}]*\}/g, "")
    .replace(/\s+key="[^"]*"/g, "")
    .replace(/\s+ref=\{[^}]*\}/g, "");

  return html;
}

/** Build a full preview HTML document from file content */
function buildPreviewDocument(files: FileNode[]): string {
  const allFiles = flattenFiles(files);
  const css = collectCSS(allFiles);
  const mainContent = extractMainContent(allFiles);

  // Extract JSX from the main component using balanced parenthesis matching
  let jsx = extractJSXBlock(mainContent);

  // Inline sub-components (e.g., <Header />, <Hero />) from other generated files
  if (jsx) {
    jsx = inlineComponents(jsx, allFiles);
  }

  // Convert JSX → static HTML
  const previewHTML = convertJSXToHTML(jsx);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <script src="https://cdn.tailwindcss.com"><\/script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    ${css.replace(/@tailwind\s+\w+;/g, "").replace(/@import\s+[^;]+;/g, "")}
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
