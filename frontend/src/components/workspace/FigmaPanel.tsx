"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Layers,
  Link2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  syncFigmaFile,
  fetchFigmaComponents,
  extractFileKey,
  validateFileKey,
  FigmaClientError,
} from "@/lib/figma-client";
import {
  mapFigmaToComponents,
  hashComponent,
} from "@/lib/figma-mapper";
import type {
  FigmaNode,
  FigmaComponent,
  FigmaComponentMapping,
  FigmaSyncStatus,
} from "@/types";

// ---------------------------------------------------------------------------
// FigmaPanel — Design sync panel for the workspace
// ---------------------------------------------------------------------------

interface FigmaPanelProps {
  projectId: string;
  tenantId: string;
}

const TYPE_BADGES: Record<string, { label: string; color: string }> = {
  button: { label: "Button", color: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  card: { label: "Card", color: "bg-purple-500/10 text-purple-400 border-purple-500/20" },
  form: { label: "Form", color: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  input: { label: "Input", color: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20" },
  table: { label: "Table", color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  layout: { label: "Layout", color: "bg-slate-500/10 text-slate-400 border-slate-500/20" },
  text: { label: "Text", color: "bg-slate-500/10 text-slate-400 border-slate-500/20" },
  image: { label: "Image", color: "bg-rose-500/10 text-rose-400 border-rose-500/20" },
  nav: { label: "Nav", color: "bg-indigo-500/10 text-indigo-400 border-indigo-500/20" },
  unknown: { label: "Other", color: "bg-slate-500/10 text-slate-500 border-slate-500/20" },
};

const ACTION_OPTIONS: Array<{ value: FigmaComponentMapping["action"]; label: string }> = [
  { value: "create", label: "Create" },
  { value: "extend", label: "Extend" },
  { value: "ignore", label: "Ignore" },
];

export function FigmaPanel({ projectId }: FigmaPanelProps) {
  const [fileKeyInput, setFileKeyInput] = useState("");
  const [syncStatus, setSyncStatus] = useState<FigmaSyncStatus>("disconnected");
  const [fileName, setFileName] = useState("");
  const [lastSynced, setLastSynced] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodeTree, setNodeTree] = useState<FigmaNode | null>(null);
  const [components, setComponents] = useState<FigmaComponent[]>([]);
  const [mappings, setMappings] = useState<FigmaComponentMapping[]>([]);
  const [expandedMappings, setExpandedMappings] = useState<Set<string>>(new Set());

  // Persist file key per project
  const storageKey = `figma-config-${projectId}`;

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const cfg = JSON.parse(saved);
        if (cfg.fileKey) setFileKeyInput(cfg.fileKey);
      }
    } catch {
      // ignore
    }
  }, [storageKey]);

  const handleSync = useCallback(async () => {
    const key = extractFileKey(fileKeyInput);
    if (!validateFileKey(key)) {
      setError("Invalid Figma file key. Paste the URL or key from your Figma file.");
      return;
    }

    setSyncStatus("connecting");
    setError(null);

    try {
      // Fetch file tree and components in parallel
      const [fileResult, compResult] = await Promise.all([
        syncFigmaFile(key),
        fetchFigmaComponents(key),
      ]);

      setFileName(fileResult.name);
      setNodeTree(fileResult.document);
      setComponents(compResult.components);
      setLastSynced(new Date().toISOString());
      setSyncStatus("synced");

      // Generate mappings
      const newMappings = mapFigmaToComponents(fileResult.document);
      // Compute hashes
      const withHashes = newMappings.map((m) => ({
        ...m,
        props: { ...m.props, _hash: hashComponent(m) },
      }));
      setMappings(withHashes);

      // Persist file key
      try {
        localStorage.setItem(storageKey, JSON.stringify({ fileKey: key }));
      } catch {
        // ignore
      }
    } catch (err) {
      const msg = err instanceof FigmaClientError
        ? err.message
        : "Failed to connect to Figma";
      setError(msg);
      setSyncStatus("error");
    }
  }, [fileKeyInput, storageKey]);

  const updateMappingAction = useCallback(
    (figmaId: string, action: FigmaComponentMapping["action"]) => {
      setMappings((prev) =>
        prev.map((m) => (m.figmaId === figmaId ? { ...m, action } : m)),
      );
    },
    [],
  );

  const toggleExpanded = useCallback((id: string) => {
    setExpandedMappings((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const activeMappings = mappings.filter((m) => m.action !== "ignore");

  // ── Disconnected State ──────────────────────────────────────────

  if (syncStatus === "disconnected" || syncStatus === "error") {
    return (
      <div className="h-full flex flex-col bg-surface-0">
        <div className="h-10 border-b border-surface-3 flex items-center px-4 shrink-0">
          <Layers className="w-3.5 h-3.5 text-brand-400 mr-2" />
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Design Sync
          </span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center p-6">
          <div className="w-14 h-14 rounded-2xl bg-surface-2 border border-surface-3 flex items-center justify-center mb-5">
            <Layers className="w-7 h-7 text-slate-500" />
          </div>

          <h3 className="text-foreground font-medium mb-1">Connect Figma</h3>
          <p className="text-slate-500 text-xs text-center max-w-xs mb-6 leading-relaxed">
            Paste your Figma file URL or file key to import components and map them to React.
          </p>

          <div className="w-full max-w-sm space-y-3">
            <div className="relative">
              <Link2 className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                value={fileKeyInput}
                onChange={(e) => setFileKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSync()}
                placeholder="https://figma.com/design/ABC123... or file key"
                className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-surface-2 border border-surface-3 text-foreground text-sm placeholder:text-slate-600 focus:outline-none focus:border-brand-500/50 focus:ring-1 focus:ring-brand-500/30 transition-all"
              />
            </div>

            <button
              onClick={handleSync}
              disabled={!fileKeyInput.trim()}
              className="w-full py-2.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-all disabled:opacity-30"
            >
              Connect & Sync
            </button>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 animate-fade-in">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <span className="text-xs text-red-400">{error}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Connecting State ────────────────────────────────────────────

  if (syncStatus === "connecting") {
    return (
      <div className="h-full flex flex-col bg-surface-0">
        <div className="h-10 border-b border-surface-3 flex items-center px-4 shrink-0">
          <Layers className="w-3.5 h-3.5 text-brand-400 mr-2" />
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Design Sync
          </span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center animate-fade-in">
          <Loader2 className="w-8 h-8 text-brand-400 animate-spin mb-4" />
          <p className="text-sm text-slate-400">Importing from Figma...</p>
          <div className="mt-3 flex gap-1">
            <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot" />
            <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.2s]" />
            <div className="w-1.5 h-1.5 rounded-full bg-brand-400 animate-pulse-dot [animation-delay:0.4s]" />
          </div>
        </div>
      </div>
    );
  }

  // ── Synced State ────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col bg-surface-0">
      {/* Header */}
      <div className="h-10 border-b border-surface-3 flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="w-3.5 h-3.5 text-brand-400" />
          <span className="text-xs font-medium text-foreground truncate max-w-[160px]">
            {fileName}
          </span>
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <CheckCircle2 className="w-2.5 h-2.5 text-emerald-400" />
            <span className="text-2xs text-emerald-400 font-medium">Synced</span>
          </div>
        </div>

        <button
          onClick={handleSync}
          className="p-1.5 rounded-md text-slate-500 hover:text-foreground hover:bg-surface-2 transition-all"
          title="Re-sync from Figma"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {/* Stats bar */}
        <div className="px-4 py-3 border-b border-surface-3/50 flex items-center gap-4">
          <div className="text-xs text-slate-500">
            <span className="text-foreground font-medium">{components.length}</span> components
          </div>
          <div className="text-xs text-slate-500">
            <span className="text-foreground font-medium">{mappings.length}</span> mappings
          </div>
          {lastSynced && (
            <div className="text-xs text-slate-600 ml-auto">
              Synced {new Date(lastSynced).toLocaleTimeString()}
            </div>
          )}
        </div>

        {/* Mapping suggestions */}
        <div className="p-3 space-y-1.5">
          <div className="text-2xs font-medium text-slate-500 uppercase tracking-wider px-1 mb-2">
            Component Mappings
          </div>

          {mappings.length === 0 ? (
            <div className="py-8 text-center text-slate-500 text-xs">
              No mappable components detected. Try syncing a file with named frames.
            </div>
          ) : (
            mappings.map((m) => {
              const badge = TYPE_BADGES[m.componentType] || TYPE_BADGES.unknown;
              const isExpanded = expandedMappings.has(m.figmaId);

              return (
                <div
                  key={m.figmaId}
                  className={cn(
                    "rounded-lg border transition-all",
                    m.action === "ignore"
                      ? "bg-surface-1/50 border-surface-3/50 opacity-60"
                      : "bg-surface-1 border-surface-3",
                  )}
                >
                  {/* Row */}
                  <div className="flex items-center gap-2 px-3 py-2">
                    <button
                      onClick={() => toggleExpanded(m.figmaId)}
                      className="text-slate-500 hover:text-foreground shrink-0"
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3 h-3" />
                      ) : (
                        <ChevronRight className="w-3 h-3" />
                      )}
                    </button>

                    {/* Name + type badge */}
                    <span className="text-xs text-foreground font-medium truncate flex-1">
                      {m.figmaName}
                    </span>
                    <span
                      className={cn(
                        "px-1.5 py-0.5 rounded text-2xs font-medium border",
                        badge.color,
                      )}
                    >
                      {badge.label}
                    </span>

                    {/* Confidence */}
                    <span className="text-2xs text-slate-500 w-8 text-right">
                      {Math.round(m.confidence * 100)}%
                    </span>

                    {/* Action selector */}
                    <select
                      value={m.action}
                      onChange={(e) =>
                        updateMappingAction(
                          m.figmaId,
                          e.target.value as FigmaComponentMapping["action"],
                        )
                      }
                      className="text-2xs bg-surface-2 border border-surface-3 rounded px-1.5 py-0.5 text-foreground focus:outline-none focus:border-brand-500/50"
                    >
                      {ACTION_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div className="px-3 pb-2 pt-0 border-t border-surface-3/50 animate-fade-in">
                      <div className="mt-2 space-y-1.5">
                        <div className="text-2xs text-slate-500">
                          ID: <span className="text-slate-400 font-mono">{m.figmaId}</span>
                        </div>
                        {m.tailwindClasses && (
                          <div className="text-2xs text-slate-500">
                            Tailwind:{" "}
                            <code className="text-brand-400 bg-surface-2 px-1 py-0.5 rounded text-2xs">
                              {m.tailwindClasses}
                            </code>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Summary bar */}
        {activeMappings.length > 0 && (
          <div className="sticky bottom-0 px-4 py-3 border-t border-surface-3 bg-surface-0/80 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs text-slate-400">
                {activeMappings.length} component{activeMappings.length !== 1 ? "s" : ""} to generate
              </span>
              <button className="px-4 py-1.5 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-xs font-medium transition-all">
                Generate Components
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
