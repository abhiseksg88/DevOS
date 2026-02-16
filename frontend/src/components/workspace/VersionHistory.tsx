"use client";

import { useState, useEffect, useCallback } from "react";
import { listProjectVersions, getProjectVersion } from "@/lib/supabase-db";
import {
  History,
  Loader2,
  RotateCcw,
  Clock,
  Zap,
  Save,
  Edit3,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileNode } from "@/types";

interface VersionHistoryProps {
  projectId: string;
  onRestore: (codeFiles: Record<string, string>) => void;
}

interface VersionEntry {
  version: number;
  label: string;
  trigger: string;
  created_at: string;
}

const triggerIcons: Record<string, typeof Zap> = {
  generation: Zap,
  autosave: Save,
  manual: Edit3,
};

const triggerLabels: Record<string, string> = {
  generation: "AI Generated",
  autosave: "Auto-saved",
  manual: "Manual Save",
};

export function VersionHistory({ projectId, onRestore }: VersionHistoryProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listProjectVersions(projectId);
      setVersions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load versions");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  const handleRestore = useCallback(async (version: number) => {
    setRestoring(version);
    try {
      const codeFiles = await getProjectVersion(projectId, version);
      onRestore(codeFiles);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to restore version");
    } finally {
      setRestoring(null);
    }
  }, [projectId, onRestore]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 animate-spin text-brand-400" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-surface-3">
        <History className="w-4 h-4 text-brand-400" />
        <span className="text-sm font-medium text-white">Version History</span>
        <span className="text-xs text-slate-500 ml-auto">{versions.length} versions</span>
      </div>

      {error && (
        <div className="mx-3 mt-2 p-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {versions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-500">
            <History className="w-8 h-8 mb-3 text-slate-600" />
            <p className="text-sm">No version history yet</p>
            <p className="text-xs text-slate-600 mt-1">Generate or edit code to create versions</p>
          </div>
        ) : (
          <div className="divide-y divide-surface-3/50">
            {versions.map((v, i) => {
              const Icon = triggerIcons[v.trigger] || Clock;
              const triggerLabel = triggerLabels[v.trigger] || v.trigger;
              const isLatest = i === 0;

              return (
                <div
                  key={v.version}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-surface-1/50 transition-all group"
                >
                  <div className={cn(
                    "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                    isLatest
                      ? "bg-brand-500/10 border border-brand-500/20"
                      : "bg-surface-2 border border-surface-3"
                  )}>
                    <Icon className={cn(
                      "w-4 h-4",
                      isLatest ? "text-brand-400" : "text-slate-500"
                    )} />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-white">v{v.version}</span>
                      {isLatest && (
                        <span className="text-2xs px-1.5 py-0.5 rounded-full bg-brand-500/10 text-brand-400 font-medium">
                          Current
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-2xs text-slate-500">{triggerLabel}</span>
                      <span className="text-2xs text-slate-600">
                        {new Date(v.created_at).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                  </div>

                  {!isLatest && (
                    <button
                      onClick={() => handleRestore(v.version)}
                      disabled={restoring !== null}
                      className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded-md text-xs text-brand-400 hover:bg-brand-500/10 transition-all disabled:opacity-50"
                    >
                      {restoring === v.version ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3 h-3" />
                      )}
                      Restore
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
