"use client";

import { useState } from "react";
import {
  RefreshCw,
  ExternalLink,
  Smartphone,
  Tablet,
  Monitor,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ViewportSize = "mobile" | "tablet" | "desktop";

const VIEWPORTS: Record<ViewportSize, { width: string; icon: typeof Monitor; label: string }> = {
  mobile: { width: "375px", icon: Smartphone, label: "Mobile" },
  tablet: { width: "768px", icon: Tablet, label: "Tablet" },
  desktop: { width: "100%", icon: Monitor, label: "Desktop" },
};

interface PreviewPaneProps {
  url: string | null;
}

export function PreviewPane({ url }: PreviewPaneProps) {
  const [viewport, setViewport] = useState<ViewportSize>("desktop");
  const [refreshKey, setRefreshKey] = useState(0);

  if (!url) {
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
        </div>

        {/* URL bar */}
        <div className="flex-1 mx-3 px-3 py-1 rounded-md bg-surface-2 border border-surface-3 text-xs text-slate-500 truncate font-mono">
          {url}
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setRefreshKey((k) => k + 1)}
            className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-md text-slate-600 hover:text-white hover:bg-surface-2 transition-all"
            title="Open in new tab"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>
      </div>

      {/* iframe */}
      <div className="flex-1 flex items-start justify-center p-4 bg-surface-2/30 overflow-auto">
        <div
          className="bg-white rounded-lg shadow-2xl overflow-hidden transition-all duration-300 h-full"
          style={{ width: VIEWPORTS[viewport].width, maxWidth: "100%" }}
        >
          <iframe
            key={refreshKey}
            src={url}
            className="w-full h-full border-0"
            title="App Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        </div>
      </div>
    </div>
  );
}
